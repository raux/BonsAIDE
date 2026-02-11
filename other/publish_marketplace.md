### 1) Install the VS Code publisher CLI

```bash
# one-off (recommended)
npx @vscode/vsce --version
# or global
npm i -g @vscode/vsce
```

### 2) Check `package.json`

Make sure you have:

* `"publisher": "dlumbrer"`
* `"name"`, `"version"`, `"engines": { "vscode": ">=1.xx.0" }`

### 3) Sign in (paste a Marketplace PAT with “Publish” scope)

```bash
npx @vscode/vsce login dlumbrer
```

### 4) Generate the VSIX (local file)

```bash
# (build first if you bundle)
npm run compile
# then package
npx @vscode/vsce package
# → creates ./<name>-<version>.vsix
```

### 5) Publish to the VS Code Marketplace

```bash
# publish using the version in package.json
npx @vscode/vsce publish

# …or bump and publish in one go:
npx @vscode/vsce publish patch    # or: minor | major
```