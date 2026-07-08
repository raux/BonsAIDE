# SKILL: BonsAIDE State & Protocol Guide

**For:** Agents modifying session state, message protocol, or data models  
**Scope:** Bonsai sessions, branches, nodes, import/export, SSE messaging  
**Related files:** `src/bonsai-state.ts`, `src/server.ts`, `client/js/app.js`

---

## Overview

BonsAIDE maintains a **tree-structured session** in memory:

- **Branches:** Top-level containers (usually just "main")
- **Nodes:** Individual code snippets with metadata
- **Graph:** Cytoscape-format nodes/edges for visualization

Changes to state are broadcast to all connected browsers via **Server-Sent Events (SSE)**.

---

## Bonsai Session State Model

### Data Structures (`src/bonsai-state.ts`)

```typescript
interface TokenUsage {
  prompt: number;           // Tokens in prompt
  completion: number;       // Tokens in generated code
  total: number;            // Sum of above
}

interface CodeNode {
  id: number;               // Unique incremental ID
  prompt: string;           // User or system prompt
  code: string;             // Generated or pasted code
  parentId: number | null;  // Parent node (null = root)
  children: CodeNode[];     // Child nodes (computed on-the-fly)
  durationMs?: number;      // Generation time in milliseconds
  tokens?: TokenUsage;      // Token usage for this generation
  reasoning?: string;       // LLM explanation (if available)
  lizard?: LizardMetrics;   // Code complexity metrics
  isLeaf: boolean;          // True if no children
  activity: string;         // Activity type (see Activities below)
}

interface Branch {
  id: string;               // Identifier ("main", "experiment-1", etc.)
  name: string;             // Display name ("Main Branch", etc.)
  nodes: CodeNode[];        // All nodes in this branch
}

interface ImportedBonsaiState {
  branches: Branch[];       // Imported branches
  activeBranchId: string | null;  // Currently selected branch
  currentId: number;        // Next node ID to allocate
}
```

### Server-Side State (`src/server.ts`)

```typescript
let branches: Branch[] = [];           // All branches in session
let activeBranchId: string | null = null;  // Current branch
let currentId = 0;                    // Next node ID
let selectedNodeId: number | null = null;  // User-selected node
let baseUrl: string = 'localhost:1234/v1';  // LM Studio endpoint
let LLMmodel: string = 'deepseek/...';     // Active LLM model
let availableModels: string[] = [];        // Pi model cache
let bonsaiLogs: string[] = [];             // Activity log for UI
```

---

## Creating & Modifying Nodes

### Creating a Root Node

```typescript
// When user pastes code in "initial" state
const rootNode: CodeNode = {
  id: currentId++,
  prompt: 'Initial code',
  code: userPastedCode,
  parentId: null,
  children: [],
  durationMs: 0,
  tokens: { prompt: 0, completion: 0, total: 0 },
  isLeaf: true,
  activity: 'initial'
};

activeBranch.nodes.push(rootNode);
```

### Creating a Child Node (Generated)

```typescript
// After LLM generation succeeds
const childNode: CodeNode = {
  id: currentId++,
  prompt: userPrompt,
  code: result.content,        // From <code> tag
  parentId: selectedNodeId,    // Link to parent
  children: [],
  durationMs: elapsedTime,
  tokens: result.tokens,
  reasoning: result.reasoning, // From <reasoning> tag
  isLeaf: true,
  activity: 'gen_tests'        // Or other activity
};

// 1. Add to branch
activeBranch.nodes.push(childNode);

// 2. Mark parent as non-leaf
const parent = activeBranch.nodes.find(n => n.id === selectedNodeId);
if (parent) parent.isLeaf = false;

// 3. Recompute leaf flags for consistency
recomputeLeafFlags(activeBranch);

// 4. Broadcast update
broadcast({ type: 'renderGraph', data: createGraphFromBranch(activeBranch) });
```

### Deleting a Node (Trim)

```typescript
// When user right-clicks → Trim
const nodeIdsToDelete = findNodeAndDescendantIds(activeBranch, nodeIdToTrim);
activeBranch.nodes = activeBranch.nodes.filter(n => !nodeIdsToDelete.has(n.id));
recomputeLeafFlags(activeBranch);

broadcast({ type: 'renderGraph', data: createGraphFromBranch(activeBranch) });
```

---

## Leaf Flag Computation

**Critical invariant:** `node.isLeaf === (node has no children in branch)`

### Recompute Logic

```typescript
export function recomputeLeafFlags(branch: Branch): void {
  // Count children for each node
  const childCount = new Map<number, number>();
  for (const n of branch.nodes) {
    childCount.set(n.id, 0);
  }
  for (const n of branch.nodes) {
    if (n.parentId != null && childCount.has(n.parentId)) {
      childCount.set(n.parentId, (childCount.get(n.parentId) || 0) + 1);
    }
  }
  
  // Update isLeaf based on child count
  for (const n of branch.nodes) {
    n.isLeaf = (childCount.get(n.id) || 0) === 0;
  }
}
```

**When to call:**
- After import
- After trim
- After any structural change

**Why important:** Leaf nodes are used for similarity comparison and UI rendering.

---

## Import/Export Schema

### Format: `bonsai.v1`

```json
{
  "schema": "bonsai.v1",
  "branches": [
    {
      "id": "main",
      "name": "Main Branch",
      "nodes": [
        {
          "id": 0,
          "prompt": "Fix bug in login",
          "code": "function login() { ... }",
          "parentId": null,
          "children": [],
          "durationMs": 1234,
          "tokens": { "prompt": 50, "completion": 120, "total": 170 },
          "reasoning": "Added error handling...",
          "lizard": { ... },
          "isLeaf": false,
          "activity": "initial"
        },
        {
          "id": 1,
          "prompt": "Fix the problem",
          "code": "function login() { try { ... } catch (...) { ... } }",
          "parentId": 0,
          "children": [],
          "durationMs": 5000,
          "tokens": { "prompt": 200, "completion": 350, "total": 550 },
          "reasoning": "Added exception handling for authentication...",
          "isLeaf": true,
          "activity": "exceptions"
        }
      ]
    }
  ],
  "activeBranchId": "main",
  "currentId": 2
}
```

### Export (`GET /export`)

```typescript
const exportData = {
  schema: 'bonsai.v1',
  branches: branches,
  activeBranchId: activeBranchId,
  currentId: currentId
};

// Send as JSON download
res.setHeader('Content-Type', 'application/json');
res.setHeader('Content-Disposition', 'attachment; filename="bonsai-session.json"');
res.end(JSON.stringify(exportData, null, 2));
```

### Import (`POST /import`)

```typescript
// Browser sends uploaded JSON file
// Server parses and validates

function importBonsaiPayload(payload: any): ImportedBonsaiState {
  // 1. Check schema
  if (!payload || payload.schema !== 'bonsai.v1') {
    throw new Error('Invalid schema. Expected "bonsai.v1".');
  }
  
  // 2. Validate branches array
  if (!Array.isArray(payload.branches)) {
    throw new Error('Invalid file: "branches" must be an array.');
  }
  
  // 3. Type-coerce and sanitize nodes
  const importedBranches: Branch[] = payload.branches.map((b: any) => ({
    id: String(b.id ?? 'main'),
    name: String(b.name ?? 'Main'),
    nodes: Array.isArray(b.nodes) ? b.nodes.map((n: any) => ({
      id: Number(n.id),                           // Coerce to number
      prompt: String(n.prompt ?? ''),
      code: String(n.code ?? ''),
      parentId: (n.parentId === null) ? null : Number(n.parentId),
      children: [],                               // Will be rebuilt
      durationMs: typeof n.durationMs === 'number' ? n.durationMs : 0,
      tokens: n.tokens ?? { prompt: 0, completion: 0, total: 0 },
      reasoning: typeof n.reasoning === 'string' ? n.reasoning : undefined,
      lizard: n.lizard,
      isLeaf: Boolean(n.isLeaf),
      activity: String(n.activity ?? 'other')
    })) : []
  }));
  
  // 4. Recompute leaf flags (critical!)
  for (const br of importedBranches) {
    recomputeLeafFlags(br);
  }
  
  // 5. Determine active branch (fallback to first if invalid)
  const requestedActiveId = typeof payload.activeBranchId === 'string' ? payload.activeBranchId : null;
  const activeBranchId = importedBranches.some(b => b.id === requestedActiveId)
    ? requestedActiveId
    : (importedBranches[0]?.id ?? null);
  
  // 6. Recompute currentId (max node ID + 1)
  const allNodeIds = importedBranches.flatMap(b => b.nodes.map(n => n.id)).filter(Number.isFinite);
  const currentId = allNodeIds.length ? Math.max(...allNodeIds) : 0;
  
  return { branches: importedBranches, activeBranchId, currentId };
}
```

**Import safety checks:**
- Schema validation (must be "bonsai.v1")
- Type coercion (nodes.id must be numbers)
- Parent-child link integrity (parentId must reference existing node)
- Leaf flag recomputation (always recompute, never trust imported isLeaf)
- Active branch fallback (if invalid, use first branch)

---

## Graph Rendering

### Creating Cytoscape Format

```typescript
export function createGraphFromBranch(branch?: Branch): GraphData {
  if (!branch) return { nodes: [], edges: [] };
  
  // 1. Compute metrics for node sizing
  const metricNodes = branch.nodes.filter(n => n.parentId !== null);  // Exclude root
  const completionVals = metricNodes.map(n => n.tokens?.completion ?? 0);
  const minTokens = completionVals.length ? Math.min(...completionVals) : 0;
  const maxTokens = completionVals.length ? Math.max(...completionVals) : 0;
  
  const durationVals = metricNodes.map(n => n.durationMs ?? 0);
  const minDuration = durationVals.length ? Math.min(...durationVals) : 0;
  const maxDuration = durationVals.length ? Math.max(...durationVals) : 0;
  
  return {
    // Create Cytoscape nodes
    nodes: branch.nodes.map(s => {
      // Size by completion tokens
      const tokens = s.tokens?.completion ?? 0;
      const size = (minTokens === maxTokens)
        ? 80
        : 40 + ((tokens - minTokens) / (maxTokens - minTokens)) * (120 - 40);
      
      // Color by generation duration (red = slow, blue = fast)
      const duration = s.durationMs ?? 0;
      const t = (maxDuration === minDuration) ? 0 : (duration - minDuration) / (maxDuration - minDuration);
      const r = Math.round(255 * t);
      const b = Math.round(255 * (1 - t));
      const timeColor = `rgb(${r},0,${b})`;
      
      // Color by activity
      const activityColor = getActivityColor(s.activity);
      
      return {
        data: {
          id: 'n' + s.id,                    // Unique Cytoscape ID
          label: '#' + s.id,                 // Display label
          code: s.code,                      // For details pane
          prompt: s.prompt,
          activity: s.activity,
          reasoning: s.reasoning,
          size: Math.round(size),            // Node radius
          activityColor,                     // Fill color
          timeColor,                         // Border color
          duration,
          durationNorm: t
        }
      };
    }),
    
    // Create Cytoscape edges
    edges: branch.nodes
      .filter(n => n.parentId !== null)
      .map(n => ({
        data: {
          source: 'n' + n.parentId,
          target: 'n' + n.id
        }
      }))
  };
}
```

### Browser-Side Rendering (`client/js/app.js`)

```javascript
// Listen for renderGraph event from server
eventSource.addEventListener('renderGraph', (event) => {
  const { data } = JSON.parse(event.data);
  
  // Update Cytoscape with new nodes/edges
  cy.elements().remove();
  cy.add(data.nodes);
  cy.add(data.edges);
  cy.layout({ name: 'dagre' }).run();  // Auto-layout DAG
});
```

---

## Message Protocol: Browser ↔ Server

### Browser → Server (POST /message)

```typescript
interface BrowserCommand {
  command: string;     // discriminant
  data: any;           // command-specific payload
}
```

**Common commands:**

| Command | Data | Purpose |
|---------|------|---------|
| `generate` | `{ nodeId, activity, count, modelId?, provider? }` | Generate N child nodes |
| `selectNode` | `{ nodeId }` | Select node + compute similarities |
| `unselectNode` | `{}` | Deselect node |
| `trim` | `{ nodeId }` | Delete node and descendants |
| `importJSON` | `{ json }` | Import session from JSON string |
| `exportSession` | `{}` | Download session as JSON |
| `setLMConfig` | `{ baseUrl, model }` | Update LLM endpoint + model |
| `loadPiModels` | `{}` | Discover available Pi models |
| `testConnection` | `{}` | Test LM Studio connectivity |
| `createBranch` | `{ name }` | Create new branch |
| `switchBranch` | `{ branchId }` | Switch to branch |

### Server → Browser (SSE Events)

```typescript
interface SSEEvent {
  type: string;        // discriminant
  data: any;          // event-specific payload
}
```

**Common events:**

| Event | Data | When |
|-------|------|------|
| `renderGraph` | `{ nodes: [...], edges: [...] }` | After structural change |
| `historyUpdate` | `{ prompt, code, reasoning, tokens, activity }` | After node selection |
| `leafSimilarities` | `{ scores: [{id, similarity}, ...] }` | After selectNode |
| `connectionTestResult` | `{ connected: bool, reason: string }` | After testConnection |
| `logMessage` | `{ message: string }` | Server log entry |
| `piModels` | `{ models: [...], count, warning? }` | After loadPiModels |
| `sessionImported` | `{ branches, activeBranchId }` | After successful import |

---

## Activities & Color Mapping

### Activity Types

```typescript
// In src/server-utils.ts
export function getActivityColor(activity: string): string {
  const colorMap: { [key: string]: string } = {
    'initial': '#E8E8E8',        // Gray (root)
    'gen_tests': '#FFB3BA',      // Red (test generation)
    'refactor': '#FFFFBA',       // Yellow (refactoring)
    'exceptions': '#BAE1FF',     // Blue (exception handling)
    'agent_md_alternative': '#E0BBE4', // Purple (alternative)
    'custom': '#BAFFC9',         // Green (custom)
    'other': '#DCDCDC'           // Light gray (fallback)
  };
  return colorMap[activity] || colorMap['other'];
}
```

### Adding a New Activity

1. Add color to `getActivityColor()` in `src/server-utils.ts`
2. Add button to `client/index.html`:
   ```html
   <button class="activity-btn" data-activity="my_activity">My Activity</button>
   ```
3. Add handler in `client/js/app.js`:
   ```javascript
   document.querySelector('[data-activity="my_activity"]').addEventListener('click', () => {
     generateBranches('my_activity', branchCount);
   });
   ```
4. Test: `npm run test` + manual UI test

---

## Edge Cases & Defensive Programming

### Handling Invalid Node IDs

```typescript
// Always check node exists before modifying
const node = activeBranch.nodes.find(n => n.id === nodeId);
if (!node) {
  broadcast({ type: 'logMessage', data: { message: `Node ${nodeId} not found.` } });
  return;
}
```

### Handling Missing Branch

```typescript
// Fallback to first branch if active branch deleted
const activeBranch = branches.find(b => b.id === activeBranchId);
if (!activeBranch && branches.length > 0) {
  activeBranchId = branches[0].id;
}
```

### Parent-Child Integrity

```typescript
// After deleting a node, check parent's children count
const parent = branch.nodes.find(n => n.id === childNode.parentId);
if (parent) {
  parent.isLeaf = !branch.nodes.some(n => n.parentId === parent.id);
}
```

---

## Testing State Changes

### Unit Tests (`test/bonsai-state.test.mjs`)

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGraphFromBranch,
  importBonsaiPayload,
  recomputeLeafFlags,
  trimBranchAtNode
} from '../out-server/bonsai-state.js';

test('import validates schema', () => {
  assert.throws(() => importBonsaiPayload({ schema: 'invalid.v0' }), /Invalid schema/);
});

test('recomputeLeafFlags updates correctly', () => {
  // Create branch with 3 nodes: 0 → [1, 2]
  const branch = { id: 'main', name: 'Test', nodes: [
    { id: 0, parentId: null, isLeaf: false, ... },
    { id: 1, parentId: 0, isLeaf: true, ... },
    { id: 2, parentId: 0, isLeaf: true, ... }
  ]};
  
  recomputeLeafFlags(branch);
  
  assert.equal(branch.nodes[0].isLeaf, false);  // Parent
  assert.equal(branch.nodes[1].isLeaf, true);   // Leaf
  assert.equal(branch.nodes[2].isLeaf, true);   // Leaf
});

test('trim removes descendants', () => {
  // ... setup branch with tree structure
  const deletedIds = trimBranchAtNode(branch, rootId);
  
  assert.ok(deletedIds.has(rootId));
  assert.ok(deletedIds.has(childId));
});
```

---

## References

- **Code:** `src/bonsai-state.ts`, `src/server.ts` (handleMessage), `client/js/app.js`
- **Tests:** `test/bonsai-state.test.mjs`
- **Schema:** Export via GET /export → inspect JSON
- **Cytoscape:** https://js.cytoscape.org/

---

**End of Skill**
