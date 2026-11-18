import path from 'node:path';

const root = process.cwd();

/** Workspace dirs (apps/x, packages/y) that contain at least one staged file. */
function workspacesOf(files) {
  const dirs = new Set();
  for (const f of files) {
    const [top, name] = path.relative(root, f).split(path.sep);
    if ((top === 'apps' || top === 'packages') && name) dirs.add(`./${top}/${name}`);
  }
  return [...dirs];
}

export default {
  '*.{ts,tsx,js,mjs,cjs}': (files) => {
    const quoted = files.map((f) => `"${f}"`).join(' ');
    const dirs = workspacesOf(files);
    const cmds = [
      `eslint --max-warnings=0 --no-warn-ignored ${quoted}`,
      `prettier --check ${quoted}`,
    ];
    // tsc can't check single files against a project config, so typecheck each touched package.
    if (dirs.length) cmds.push(`turbo run typecheck ${dirs.map((d) => `--filter=${d}`).join(' ')}`);
    return cmds;
  },
  '*.{json,md,yml,yaml,css}': (files) => `prettier --check ${files.map((f) => `"${f}"`).join(' ')}`,
};
