import { DocProps } from '.';
import storybook from '@storybook/react/standalone';
import generator from './storybook-generator';

export function devOrBuild({ cwd, cmd, DOC_PATH, args = {} }: Partial<DocProps>) {
  const { storybookPath } = generator(cwd);

  if (cmd === 'build') {
    return storybook({ // 这里要查看storybook文档
      mode: 'static',
      outputDir: DOC_PATH,
      configDir: storybookPath,
    });
  } else {
    // Dev mode
    process.env.NODE_ENV = 'development';

    return storybook({
      mode: 'dev',
      port: args.port || 9001,
      configDir: storybookPath,
    });
  }
}
