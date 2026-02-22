/**
 * lizard-server.ts
 *
 * Standalone (non-VS Code) wrapper around the Lizard Python package.
 * Mirrors the public API of lizard.ts but replaces VS Code UI calls with
 * console output so it can be used in the standalone web server.
 */

import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function execPromise(cmd: string, opts: { cwd?: string } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      if (error) { return reject({ error, stdout, stderr }); }
      resolve({ stdout, stderr });
    });
  });
}

function execFilePromise(bin: string, args: string[], opts: { cwd?: string } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 10 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      if (error) { return reject({ error, stdout, stderr }); }
      resolve({ stdout, stderr });
    });
  });
}

/** Try to find a usable Python command on the current platform */
async function findPython(): Promise<string | null> {
  const candidates = process.platform === 'win32'
    ? ['py', 'python', 'python3']
    : ['python3', 'python'];

  for (const cmd of candidates) {
    try {
      const { stdout, stderr } = await execFilePromise(cmd, ['--version']);
      if (/Python\s+\d+\.\d+\.\d+/.test(stdout) || /Python\s+\d+\.\d+\.\d+/.test(stderr)) {
        return cmd;
      }
    } catch { /* try next */ }
  }
  return null;
}

/** Ensure Python is installed; if not, log an error and throw */
async function ensurePythonInstalled(): Promise<string> {
  const py = await findPython();
  if (py) { return py; }
  const msg = 'Python was not found on your system. It is required to install/run Lizard.';
  console.error(msg);
  throw new Error(msg);
}

/** Install Lizard using the provided Python interpreter (user site-packages) */
async function installLizardWith(pyCmd: string): Promise<void> {
  console.log('Installing Lizard (Python package)...');

  try {
    await execFilePromise(pyCmd, ['-m', 'pip', '--version']);
  } catch {
    try {
      await execFilePromise(pyCmd, ['-m', 'ensurepip', '--upgrade']);
    } catch {
      throw new Error('Failed to initialize pip for this Python interpreter.');
    }
  }

  try {
    await execFilePromise(pyCmd, ['-m', 'pip', 'install', '--user', 'lizard']);
  } catch (e: any) {
    const stderr = e?.stderr ?? '';
    throw new Error(`Lizard installation failed: ${stderr || e}`);
  }
}

/** Check whether Lizard (Python module) is available */
async function isLizardAvailable(pyCmd: string): Promise<boolean> {
  try {
    await execFilePromise(pyCmd, ['-c', 'import lizard']);
    return true;
  } catch (error) {
    console.log('Lizard is not available:', error);
    return false;
  }
}

/** Ensure wrapper exists: write a temp copy and cache the path */
let cachedWrapperPath: string | null = null;
async function ensureWrapperPath(): Promise<string> {
  if (cachedWrapperPath && fs.existsSync(cachedWrapperPath)) { return cachedWrapperPath; }

  const content = `
import sys, json, lizard

def analyze(path: str):
    result = lizard.analyze_file(path)
    return {
        "filename": result.filename,
        "nloc": result.nloc,
        "token_count": result.token_count,
        "function_count": len(result.function_list),
        "average_ccn": result.average_cyclomatic_complexity,
        "avg_nloc": result.average_nloc,
        "avg_token_count": result.average_token_count,
        "functions": [
            {
                "name": f.name,
                "long_name": getattr(f, "long_name", f.name),
                "nloc": f.nloc,
                "ccn": f.cyclomatic_complexity,
                "token_count": f.token_count,
                "parameters": f.parameter_count,
                "start_line": f.start_line,
                "end_line": f.end_line,
                "filename": f.filename,
            }
            for f in result.function_list
        ]
    }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python lizard_wrapper.py <file>")
        sys.exit(1)
    path = sys.argv[1]
    metrics = analyze(path)
    print(json.dumps(metrics))
`.trimStart();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonsai-lizard-'));
  const tempFile = path.join(tempDir, 'lizard_wrapper.py');
  await fs.promises.writeFile(tempFile, content, 'utf8');
  cachedWrapperPath = tempFile;
  return tempFile;
}

/**
 * Analyze a file with Lizard (via a Python wrapper) and return JSON metrics.
 * Throws on failure; caller is responsible for catch/fallback.
 */
export async function analyzeWithLizardServer<T = any>(fileOrDirPath: string): Promise<T> {
  const py = await ensurePythonInstalled();

  if (!(await isLizardAvailable(py))) {
    await installLizardWith(py);
  }

  const wrapper = await ensureWrapperPath();

  try {
    const { stdout } = await execFilePromise(py, [wrapper, fileOrDirPath]);
    return JSON.parse(stdout) as T;
  } catch (e: any) {
    const msg = e?.stderr || e?.stdout || String(e);
    console.error('Lizard analysis error:', msg);
    throw e;
  }
}

/** Write code to a temp file with the right extension and analyze it with Lizard */
export async function analyzeCodeWithLizardServer(
  code: string,
  nameHint = 'snippet',
  ext: string
): Promise<any | undefined> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonsai-'));
  const tempFile = path.join(tempDir, `${nameHint}${ext}`);

  try {
    await fs.promises.writeFile(tempFile, code, 'utf8');
    return await analyzeWithLizardServer(tempFile);
  } catch {
    return undefined;
  } finally {
    try { await fs.promises.unlink(tempFile); } catch { /* ignore */ }
    try { await fs.promises.rmdir(tempDir); } catch { /* ignore */ }
  }
}
