// `grapim mount <workspace-url> [drive-letter | mount-point]`: the
// workspace as a network drive (WebDAV at <workspace>/dav/, see
// docs/workspaces.md "Mount as a drive").
//
// On Windows with a drive letter it runs `net use`; everywhere else it prints
// the exact steps. The token comes from $GRAPIM_WORKSPACE_TOKEN only, never
// from the command line (it would land in shell history and process lists),
// and is never printed.

import { spawnSync } from 'node:child_process';

const TOKEN_ENV = 'GRAPIM_WORKSPACE_TOKEN';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const WS_PATH = /^\/w\/([A-Za-z0-9_-]{6,40})\/([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)(?:\/(?:dav\/?)?)?$/;

const usage = 'Usage: grapim mount <workspace-url> [drive-letter | mount-point]   (token from $GRAPIM_WORKSPACE_TOKEN)';

// The drive's address for a workspace URL (or a local grapim serve URL).
export function davUrlOf(raw) {
  let u;
  try {
    u = new URL(String(raw ?? ''));
  } catch {
    throw new Error(`Give a workspace address like https://app.grapim.com/w/<team>/<workspace>/. ${usage}`);
  }
  const local = LOOPBACK.has(u.hostname.toLowerCase()) || u.hostname === '::1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('The drive sends your token as a password, so the address must start with https:// (plain http only for this machine).');
  if (u.username || u.password || u.search || u.hash) throw new Error('Give the workspace address alone, without a user, password, query or #.');
  const m = WS_PATH.exec(u.pathname);
  if (m) return { url: `${u.origin}/w/${m[1]}/${m[2]}/dav/`, name: m[2] };
  if (local && /^\/(dav\/?)?$/.test(u.pathname)) return { url: `${u.origin}/dav/`, name: 'grapim' };
  throw new Error(`Give a workspace address like https://app.grapim.com/w/<team>/<workspace>/, not ${u.pathname}.`);
}

// What to run (Windows with a drive letter) and what to print.
// -> { url, run: { cmd, args } | null, text }
export function mountPlan(args, { env = process.env, platform = process.platform } = {}) {
  if (args.some((a) => /^gws_/.test(a))) throw new Error(`Put the token in $${TOKEN_ENV}, never on the command line: it would stay in your shell history.`);
  if (!args.length || args.length > 2 || args.some((a) => a.startsWith('--'))) throw new Error(usage);
  const { url, name } = davUrlOf(args[0]);
  const where = args[1] ?? null;
  const token = env[TOKEN_ENV] || null;
  const host = new URL(url).host;

  if (platform === 'win32') {
    const letter = where && /^[A-Za-z]:?$/.test(where) ? `${where[0].toUpperCase()}:` : null;
    if (where && !letter) throw new Error(`On Windows, give a drive letter such as Z:, not "${where}".`);
    const lines = [
      `Drive address: ${url}`,
      '',
      'File Explorer: right-click This PC > Map network drive > "Connect to a Web site that you can use to store your documents and pictures",',
      `  paste the address, then sign in with any user name and your workspace token as the password.`,
      'Or in PowerShell:',
      `  net use Z: ${url} /user:grapim $env:${TOKEN_ENV}`,
      '',
      'Windows (the WebClient service) refuses files over 50 MB by default. To raise it, as administrator:',
      '  reg add HKLM\\SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters /v FileSizeLimitInBytes /t REG_DWORD /d 4294967295 /f',
      '  net stop webclient & net start webclient',
      'Grapim itself takes files up to 32 MB each.',
    ];
    if (!letter) return { url, run: null, text: lines.join('\n') };
    if (!token) throw new Error(`Set $${TOKEN_ENV} to a token of this workspace (created on its hub page) first.`);
    return {
      url,
      run: { cmd: 'net', args: ['use', letter, url, '/user:grapim', token] },
      text: `Mapping ${letter} to ${url} (user grapim, the password from $${TOKEN_ENV}).`,
    };
  }

  if (platform === 'darwin') {
    const dir = where ?? `~/grapim/${name}`;
    return {
      url,
      run: null,
      text: [
        `Drive address: ${url}`,
        '',
        'Finder: Go > Connect to Server (Cmd K), paste the address, Connect,',
        '  then sign in as a Registered User: any name, and your workspace token as the password.',
        'Or in Terminal (it asks for the name and password):',
        `  mkdir -p ${dir} && mount_webdav -i ${url} ${dir}`,
      ].join('\n'),
    };
  }

  const dir = where ?? `/mnt/${name}`;
  return {
    url,
    run: null,
    text: [
      `Drive address: ${url}`,
      '',
      'GNOME Files: Other Locations > Connect to Server, enter',
      `  davs://${host}${new URL(url).pathname}`,
      '  then any user name and your workspace token as the password. Or: gio mount davs://...',
      'davfs2 (sudo apt install davfs2):',
      `  echo "${url} grapim $${TOKEN_ENV}" | sudo tee -a /etc/davfs2/secrets >/dev/null && sudo chmod 600 /etc/davfs2/secrets`,
      `  sudo mkdir -p ${dir} && sudo mount -t davfs -o uid=$(id -u),gid=$(id -g) ${url} ${dir}`,
    ].join('\n'),
  };
}

export function mountMain(args, { env = process.env, platform = process.platform, run = spawnSync } = {}) {
  let plan;
  try {
    plan = mountPlan(args, { env, platform });
  } catch (err) {
    console.error(`grapim mount: ${err.message}`);
    return 1;
  }
  console.log(plan.text);
  if (!plan.run) return 0;
  const r = run(plan.run.cmd, plan.run.args, { stdio: 'inherit', windowsHide: true });
  if (r.error || r.status !== 0) {
    console.error('grapim mount: net use failed. Check that the WebClient service can start (services.msc > WebClient > Automatic), and that the token belongs to this workspace.');
    return 1;
  }
  return 0;
}
