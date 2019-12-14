import { join, extname, relative } from 'path';
import { existsSync, readFileSync, statSync } from 'fs';
import vfs from 'vinyl-fs';
import signale from 'signale';
import rimraf from 'rimraf';
import through from 'through2';
import slash from 'slash2';
import * as chokidar from 'chokidar';
import * as babel from '@babel/core';
import gulpTs from 'gulp-typescript';
import gulpLess from 'gulp-less';
import gulpIf from 'gulp-if';
import chalk from "chalk";
import getBabelConfig from './getBabelConfig';
import { IBundleOptions } from './types';
import * as ts from 'typescript';

interface IBabelOpts {
  cwd: string;
  rootPath?: string;
  type: 'esm' | 'cjs';
  target?: 'browser' | 'node';
  log?: (string) => void;
  watch?: boolean;
  importLibToEs?: boolean;
  bundleOpts: IBundleOptions;
}

interface ITransformOpts {
  file: {
    contents: string;
    path: string;
  };
  type: 'esm' | 'cjs';
}

export default async function(opts: IBabelOpts) {
  const {
    cwd,
    rootPath,
    type,
    watch,
    importLibToEs,
    log,
    bundleOpts: {
      target = 'browser',
      runtimeHelpers,
      extraBabelPresets = [],
      extraBabelPlugins = [],
      browserFiles = [],
      nodeFiles = [],
      nodeVersion,
      disableTypeCheck,
      cjs,
      lessInBabelMode,
    },
  } = opts;
  // src路径
  const srcPath = join(cwd, 'src');
  const targetDir = type === 'esm' ? 'es' : 'lib';
  // 打包目标路径
  const targetPath = join(cwd, targetDir);

  log(chalk.gray(`Clean ${targetDir} directory`));
  rimraf.sync(targetPath);

  function transform(opts: ITransformOpts) {
    const { file, type } = opts;
    const { opts: babelOpts, isBrowser } = getBabelConfig({
      target,
      type,
      typescript: true,
      runtimeHelpers,
      filePath: slash(relative(cwd, file.path)),
      browserFiles,
      nodeFiles,
      nodeVersion,
      lazy: cjs && cjs.lazy,
      lessInBabelMode,
    });
    if (importLibToEs && type === 'esm') {
      babelOpts.plugins.push(require.resolve('../lib/importLibToEs')); // 这个插件的作用是将/lib/de引入转化为/es/
    }
    babelOpts.presets.push(...extraBabelPresets);
    babelOpts.plugins.push(...extraBabelPlugins);

    const relFile = slash(file.path).replace(`${cwd}/`, '');
    log(`Transform to ${type} for ${chalk[isBrowser ? 'yellow' : 'blue'](relFile)}`);

    return babel.transform(file.contents, { // babel转换
      ...babelOpts,
      filename: file.path,
    }).code;
  }

  /**
   * tsconfig.json is not valid json file
   * https://github.com/Microsoft/TypeScript/issues/20384
   */
  function parseTsconfig(path: string) {
    const readFile = (path:string) => readFileSync(path, 'utf-8')
    const result = ts.readConfigFile(path, readFile)
    if (result.error) {
      return
    }
    return result.config
  }

  function getTsconfigCompilerOptions(path: string) {
    const config = parseTsconfig(path)
    return config ? config.compilerOptions : undefined
  }

  // 获取tsconfig, 如果当前包下没有, 去取根包下的, 如果还没有, 提供默认的
  function getTSConfig() {
    const tsconfigPath = join(cwd, 'tsconfig.json');
    const templateTsconfigPath = join(__dirname, '../template/tsconfig.json');

    if (existsSync(tsconfigPath)) {
      return getTsconfigCompilerOptions(tsconfigPath) || {};
    }
    if (rootPath && existsSync(join(rootPath, 'tsconfig.json'))) {
      return getTsconfigCompilerOptions(join(rootPath, 'tsconfig.json')) || {};
    }
    return getTsconfigCompilerOptions(templateTsconfigPath) || {};
  }

  function createStream(src) {
    // 获取cwd下的ts编译配置
    const tsConfig = getTSConfig();
    const babelTransformRegexp = disableTypeCheck ? /\.(t|j)sx?$/ : /\.jsx?$/;

    function isTsFile(path) {
      return /\.tsx?$/.test(path) && !path.endsWith('.d.ts');
    }

    function isTransform(path) {
      return babelTransformRegexp.test(path) && !path.endsWith('.d.ts');
    }

    return vfs // 转换
      .src(src, {
        allowEmpty: true,
        base: srcPath,
      })
      .pipe(gulpIf(f => !disableTypeCheck && isTsFile(f.path), gulpTs(tsConfig))) // ts转换
      // less转换成css, 这里只做简单的less->css, 没有用postcss等less插件(不同于rollup)
      .pipe(gulpIf(f => lessInBabelMode && /\.less$/.test(f.path), gulpLess(lessInBabelMode || {}))) 
      .pipe(
        gulpIf(
          f => isTransform(f.path),
          through.obj((file, env, cb) => {
            try {
              file.contents = Buffer.from(
                transform({
                  file,
                  type,
                }),
              );
              // .jsx -> .js 全部转换成js文件
              file.path = file.path.replace(extname(file.path), '.js');
              cb(null, file);
            } catch (e) {
              signale.error(`Compiled faild: ${file.path}`);
              console.log(e);
              cb(null);
            }
          }),
        ),
      )
      .pipe(vfs.dest(targetPath));
  }

  return new Promise(resolve => {
    const patterns = [
      join(srcPath, '**/*'), // 这里编译所有文件, 可能有less
      `!${join(srcPath, '**/fixtures{,/**}')}`, // 不包括fixture
      `!${join(srcPath, '**/__test__{,/**}')}`, // 不包括test文件夹
      `!${join(srcPath, '**/*.mdx')}`, // 不包括mdx
      `!${join(srcPath, '**/*.+(test|e2e|spec).+(js|jsx|ts|tsx)')}`,
    ];
    createStream(patterns).on('end', () => {
      if (watch) { // 文件监控
        log(chalk.magenta(`Start watching ${slash(srcPath).replace(`${cwd}/`, '')} directory...`));
        const watcher = chokidar
          .watch(patterns, {
            ignoreInitial: true,
          });
          // 监听所有文件的变化
        watcher.on('all', (event, fullPath) => {
          const relPath = fullPath.replace(srcPath, '');
          log(`[${event}] ${slash(join(srcPath, relPath)).replace(`${cwd}/`, '')}`);
          if (!existsSync(fullPath)) return;
          if (statSync(fullPath).isFile()) {
            createStream([fullPath]);
          }
        });
        // 取消回调
        process.once('SIGINT', () => {
          watcher.close();
        });
      }
      resolve();
    });
  });
}
