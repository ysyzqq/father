#!/usr/bin/env node

const { existsSync } = require('fs');
const { join } = require('path');
const yParser = require('yargs-parser');
const chalk = require('chalk');
const assert = require('assert');
const signale = require('signale');
const preCommit = require('../lib/preCommit');

// print version and @local
const args = yParser(process.argv.slice(2));
if (args.v || args.version) {
  console.log(require('../package').version);
  if (existsSync(join(__dirname, '../.local'))) {
    console.log(chalk.cyan('@local'));
  }
  process.exit(0);
}

// Notify update when process exits
const updater = require('update-notifier');
const pkg = require('../package.json');
updater({ pkg }).notify({ defer: true });

// Check if pre commit config
// 先执行eslint, prettier相关的代码检测
preCommit.install();

const cwd = process.cwd();

// 打包文档相关, 这里主要用的是storybook和docz
async function doc(args) {
  const cmd = args._[1];
  assert.ok(
    ['build', 'dev', 'deploy'].includes(cmd),
    `Invalid subCommand ${cmd}`,
  );

  switch (cmd) {
    case 'build':
    case 'dev':
      return await require('../lib/doc')
        .devOrBuild({
          cwd,
          cmd: args._[1],
          args,
          // extra args to docz
          params: process.argv.slice(4),
        });
    case 'deploy':
      return await require('../lib/doc')
        .deploy({
          cwd,
          args,
        });
  }
}

// 支持的command, 没有dev因为这是个打包工具
switch (args._[0]) {
  case 'pre-commit':
    preCommit.check();
    break;
  case 'build':
    build();
    break;
  case 'doc':
    doc(args).catch(e => {
      signale.error(e);
      process.exit(1);
    });
    break;
  case 'test':
    require('../lib/test')(args);
    break;
  case 'help':
  case undefined:
    printHelp();
    break;
  default:
    console.error(chalk.red(`Unsupported command ${args._[0]}`));
    process.exit(1);
}

function stripEmptyKeys(obj) {
  Object.keys(obj).forEach((key) => {
    if (!obj[key] || (Array.isArray(obj[key]) && !obj[key].length)) {
      delete obj[key];
    }
  });
  return obj;
}

function build() {
  // Parse buildArgs from cli
  // 解析命令行参数, father build ./ --file --esm --cjs --umd --target
  const buildArgs = stripEmptyKeys({
    esm: args.esm && { type: args.esm === true ? 'rollup' : args.esm }, // 生成模块的策略
    cjs: args.cjs && { type: args.cjs === true ? 'rollup' : args.cjs },
    umd: args.umd && { name: args.umd === true ? undefined : args.umd },
    file: args.file, // 打包文件
    target: args.target, // 打包目标, 一般分为browser和node
    entry: args._.slice(1), // 打包入口
  });

  if (buildArgs.file && buildArgs.entry && buildArgs.entry.length > 1) { // 只能单入口
    signale.error(new Error(
      `Cannot specify file when have multiple entries (${buildArgs.entry.join(', ')})`
    ));
    process.exit(1);
  }

  require('father-build').default({ // 真正的打包是father-build做的
    cwd,
    watch: args.w || args.watch,
    buildArgs,
  }).catch(e => {
    signale.error(e);
    process.exit(1);
  });
}

function printHelp() {
  console.log(`
  Usage: father <command> [options]

  Commands:

    ${chalk.green('build')}       build library
  `);
}
