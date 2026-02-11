// src/lizard.ts
import * as vscode from 'vscode';
import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function execPromise(cmd: string, opts: { cwd?: string } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      if (error) return reject({ error, stdout, stderr });
      resolve({ stdout, stderr });
    });
  });
}

function execFilePromise(bin: string, args: string[], opts: { cwd?: string } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 10 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      if (error) return reject({ error, stdout, stderr });
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

/** Ensure Python is installed; if not, guide the user and throw */
async function ensurePythonInstalled(): Promise<string> {
  const py = await findPython();
  if (py) return py;

  const platform = process.platform;
  const action = await vscode.window.showErrorMessage(
    'Python was not found on your system. It is required to install/run Lizard.',
    'Open installation guide'
  );
  console.error('Python is not installed or not available on PATH.');

  if (action === 'Open installation guide') {
    const url =
      platform === 'win32'
        ? 'https://www.python.org/downloads/windows/'
        : platform === 'darwin'
          ? 'https://www.python.org/downloads/macos/'
          : 'https://www.python.org/downloads/';
    void vscode.env.openExternal(vscode.Uri.parse(url));
  }
  throw new Error('Python is not installed or not available on PATH.');
}

/** Install Lizard using the provided Python interpreter (user site-packages) */
async function installLizardWith(pyCmd: string): Promise<void> {
  vscode.window.showInformationMessage('Installing Lizard (Python package)...');

  // Ensure pip is available for that interpreter
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

/** Ensure wrapper exists: prefer repo version; otherwise, write a temp copy and reuse it */
let cachedWrapperPath: string | null = null;
async function ensureWrapperPath(): Promise<string> {
  if (cachedWrapperPath && fs.existsSync(cachedWrapperPath)) return cachedWrapperPath;

  // 1) Look for a checked-in script at "<workspace>/scripts/lizard_wrapper.py"
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    for (const f of folders) {
      const p = path.join(f.uri.fsPath, 'scripts', 'lizard_wrapper.py');
      if (fs.existsSync(p)) {
        cachedWrapperPath = p;
        return p;
      }
    }
  }

  // 2) If not found, create a temp file with the wrapper content
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
 * @param fileOrDirPath Absolute path to a file (recommended). (Directory is not supported by the wrapper as-is.)
 */
export async function analyzeWithLizard<T = any>(fileOrDirPath: string): Promise<T> {
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
    vscode.window.showErrorMessage(`Lizard analysis failed: ${msg}`);
    console.error('Lizard analysis error:', e);
    throw e;
  }
}
