import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import rimraf from 'rimraf';
import * as assert from 'assert';
import { merge } from 'lodash';
import signale from 'signale';
import chalk from 'chalk';
import { IOpts, IBundleOptions, IBundleTypeOutput, ICjs, IEsm } from './types';
import babel from './babel';
import rollup from './rollup';
import registerBabel from './registerBabel';
import { getExistFile } from './utils';
import getUserConfig, { CONFIG_FILES } from './getUserConfig';
import randomColor from "./randomColor";

// 获取打包配置
export function getBundleOpts(opts: IOpts): IBundleOptions[] {
  const { cwd, buildArgs = {}, rootConfig = {} } = opts;
  // 入口文件
  const entry = getExistFile({
    cwd,
    files: ['src/index.tsx', 'src/index.ts', 'src/index.jsx', 'src/index.js'],
    returnRelative: true,
  });
  // fatherrc配置文件
  const userConfig = getUserConfig({ cwd });
  const userConfigs = Array.isArray(userConfig) ? userConfig : [userConfig];
  return (userConfigs as any).map(userConfig => {
    // 参数的优先级合并
    const bundleOpts = merge(
      {
        entry,
      },
      rootConfig,
      userConfig,
      buildArgs,
    );

    // Support config esm: 'rollup' and cjs: 'rollup'
    if (typeof bundleOpts.esm === 'string') {
      bundleOpts.esm = { type: bundleOpts.esm };
    }
    if (typeof bundleOpts.cjs === 'string') {
      bundleOpts.cjs = { type: bundleOpts.cjs };
    }

    return bundleOpts;
  });
}

function validateBundleOpts(bundleOpts: IBundleOptions, { cwd, rootPath }) {
  if (bundleOpts.runtimeHelpers) {
    const pkgPath = join(cwd, 'package.json');
    assert.ok(existsSync(pkgPath), `@babel/runtime dependency is required to use runtimeHelpers`);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    assert.ok(
      (pkg.dependencies || {})['@babel/runtime'],
      `@babel/runtime dependency is required to use runtimeHelpers`,
    );
  }
  if (bundleOpts.cjs && (bundleOpts.cjs as ICjs).lazy && (bundleOpts.cjs as ICjs).type === 'rollup') {
    throw new Error(`
cjs.lazy don't support rollup.
    `.trim());
  }
  if (!bundleOpts.esm && !bundleOpts.cjs && !bundleOpts.umd) {
    throw new Error(
      `
None format of ${chalk.cyan(
        'cjs | esm | umd',
      )} is configured, checkout https://github.com/umijs/father for usage details.
`.trim(),
    );
  }
  if (bundleOpts.entry) {
    const tsConfigPath = join(cwd, 'tsconfig.json');
    const tsConfig = existsSync(tsConfigPath)
      || (rootPath && existsSync(join(rootPath, 'tsconfig.json')));
    if (
      !tsConfig && (
        (Array.isArray(bundleOpts.entry) && bundleOpts.entry.some(isTypescriptFile)) ||
        (!Array.isArray(bundleOpts.entry) && isTypescriptFile(bundleOpts.entry))
      )
    ) {
      signale.info(
        `Project using ${chalk.cyan('typescript')} but tsconfig.json not exists. Use default config.`
      );
    }
  }
}

function isTypescriptFile(filePath) {
  return filePath.endsWith('.ts') || filePath.endsWith('.tsx')
}

interface IExtraBuildOpts {
  pkg?: string;
}

export async function build(opts: IOpts, extraOpts: IExtraBuildOpts = {}) {
  const { cwd, rootPath, watch } = opts;
  const { pkg } = extraOpts;

  // register babel for config files
  registerBabel({
    cwd,
    only: CONFIG_FILES,
  });

  function log(msg) {
    console.log(`${pkg ? `${randomColor(`${pkg}`)}: ` : ''}${msg}`);
  }

  // Get user config
  const bundleOptsArray = getBundleOpts(opts);
  for (const bundleOpts of bundleOptsArray) {
    // 验证打包配置
    validateBundleOpts(bundleOpts, { cwd, rootPath });

    // Clean dist
    log(chalk.gray(`Clean dist directory`));
    // 先清除打包dist文件夹
    rimraf.sync(join(cwd, 'dist'));

    // Build umd 打包umd 只能用rollup, 这里一般是文件里直接引入了less样式之类的UI库会用umd
    if (bundleOpts.umd) {
      log(`Build umd`);
      await rollup({
        cwd,
        log,
        type: 'umd',
        entry: bundleOpts.entry,
        watch,
        bundleOpts,
      });
    }

    // Build cjs
    if (bundleOpts.cjs) {
      const cjs = bundleOpts.cjs as IBundleTypeOutput;
      log(`Build cjs with ${cjs.type}`);
      // 判断是用babel编译所有的文件还是rollup打包出单文件
      if (cjs.type === 'babel') {
        await babel({ cwd, rootPath, watch, type: 'cjs', log, bundleOpts });
      } else {
        await rollup({
          cwd,
          log,
          type: 'cjs',
          entry: bundleOpts.entry,
          watch,
          bundleOpts,
        });
      }
    }

    // Build esm
    if (bundleOpts.esm) {
      const esm = bundleOpts.esm as IEsm;
      log(`Build esm with ${esm.type}`);
      const importLibToEs = esm && esm.importLibToEs;
      if (esm && esm.type === 'babel') {
        await babel({ cwd, rootPath, watch, type: 'esm', importLibToEs, log, bundleOpts });
      } else {
        await rollup({
          cwd,
          log,
          type: 'esm',
          entry: bundleOpts.entry,
          importLibToEs,
          watch,
          bundleOpts,
        });
      }
    }
  }
}

export async function buildForLerna(opts: IOpts) {
  const { cwd } = opts;

  // register babel for config files
  // 为多包根路径的配置文件注册babel
  registerBabel({
    cwd,
    only: CONFIG_FILES,
  });
  // 获取用户配置文件 这里是lerna根目录的rc文件, 配置了各个包的打包顺序, 因为有依赖关系所以有的包要先打
  const userConfig = getUserConfig({ cwd });
  let pkgs = readdirSync(join(cwd, 'packages'));

  // support define pkgs in lerna
  // 支持检索lerna的package
  if (userConfig.pkgs) {
    pkgs = userConfig.pkgs;
  }

  // 支持 scope
  pkgs = pkgs.reduce((memo, pkg) => {
    // 每个包的根路径;
    const pkgPath = join(cwd, 'packages', pkg);
    if (statSync(pkgPath).isDirectory()) {
      if (pkg.startsWith('@')) { // @开头, 获取子包名
        readdirSync(join(cwd, 'packages', pkg)).filter(subPkg => {
          if (statSync(join(cwd, 'packages', pkg, subPkg)).isDirectory()) {
            memo = memo.concat(`${pkg}/${subPkg}`);
          }
        });
      } else {
        memo = memo.concat(pkg);
      }
    }
    return memo;
  }, []);
  // 获取到了所有的包名; 例如: ['umi','umi-core','umi-ui']
  for (const pkg of pkgs) {
    // 这里是为了支持单包构建, 指定包去build
    if (process.env.PACKAGE && pkg !== process.env.PACKAGE) continue;
    // build error when .DS_Store includes in packages root
    // 包的绝对路径
    const pkgPath = join(cwd, 'packages', pkg);
    assert.ok(
      existsSync(join(pkgPath, 'package.json')),
      `package.json not found in packages/${pkg}`,
    );
    // 进程切换到对应的包
    process.chdir(pkgPath);
    await build(
      {
        // eslint-disable-line
        ...opts,
        buildArgs: opts.buildArgs,
        rootConfig: userConfig,
        cwd: pkgPath, // 这时的cwd就是对应包的根路径
        rootPath: cwd, // 保存根进程路径
      },
      {
        pkg,
      },
    );
  }
}

export default async function(opts: IOpts) {
  const useLerna = existsSync(join(opts.cwd, 'lerna.json'));
  if (useLerna && process.env.LERNA !== 'none') { // 处理多包的情况
    await buildForLerna(opts);
  } else {
    await build(opts);
  }
}
