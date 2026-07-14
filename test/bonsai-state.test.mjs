import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGraphFromBranch,
  findNodeAndDescendantIds,
  importBonsaiPayload,
  recomputeLeafFlags,
  trimBranchAtNode,
} from '../out-server/bonsai-state.js';

function node(id, parentId = null, isLeaf = false) {
  return {
    id,
    prompt: `prompt-${id}`,
    code: `code-${id}`,
    parentId,
    children: [],
    durationMs: id * 10,
    tokens: { prompt: 1, completion: id * 5, total: id * 5 + 1 },
    isLeaf,
    activity: id === 1 ? 'initial' : 'refactor',
  };
}

test('recomputeLeafFlags marks only nodes without children as leaves', () => {
  const branch = { id: 'main', name: 'Main', nodes: [node(1, null, true), node(2, 1, true), node(3, 1, true)] };

  recomputeLeafFlags(branch);

  assert.equal(branch.nodes.find(n => n.id === 1).isLeaf, false);
  assert.equal(branch.nodes.find(n => n.id === 2).isLeaf, true);
  assert.equal(branch.nodes.find(n => n.id === 3).isLeaf, true);
});

test('findNodeAndDescendantIds returns the selected node and all descendants', () => {
  const branch = { id: 'main', name: 'Main', nodes: [node(1), node(2, 1), node(3, 2), node(4, 1)] };

  const ids = findNodeAndDescendantIds(branch, 2);

  assert.deepEqual([...ids].sort((a, b) => a - b), [2, 3]);
});

test('trimBranchAtNode deletes a subtree and recomputes leaf flags', () => {
  const branch = { id: 'main', name: 'Main', nodes: [node(1), node(2, 1), node(3, 2), node(4, 1)] };

  const deleted = trimBranchAtNode(branch, 2);

  assert.deepEqual([...deleted].sort((a, b) => a - b), [2, 3]);
  assert.deepEqual(branch.nodes.map(n => n.id), [1, 4]);
  assert.equal(branch.nodes.find(n => n.id === 1).isLeaf, false);
  assert.equal(branch.nodes.find(n => n.id === 4).isLeaf, true);
});

test('createGraphFromBranch emits Cytoscape nodes, custom labels, and parent edges', () => {
  const child = node(2, 1);
  child.label = 'Code 1.1';
  const branch = { id: 'main', name: 'Main', nodes: [node(1, null), child] };

  const graph = createGraphFromBranch(branch);

  assert.deepEqual(graph.nodes.map(n => n.data.id), ['n1', 'n2']);
  assert.deepEqual(graph.nodes.map(n => n.data.label), ['#1', 'Code 1.1']);
  assert.deepEqual(graph.edges, [{ data: { source: 'n1', target: 'n2' } }]);
  assert.equal(graph.nodes[1].data.activityColor, '#006d18');
});

test('createGraphFromBranch handles missing branch and equal metric ranges', () => {
  assert.deepEqual(createGraphFromBranch(undefined), { nodes: [], edges: [] });

  const branch = { id: 'main', name: 'Main', nodes: [node(1, null)] };
  const graph = createGraphFromBranch(branch);

  assert.equal(graph.nodes[0].data.size, 80);
  assert.equal(graph.nodes[0].data.durationNorm, 0);
});

test('importBonsaiPayload validates schema and branches', () => {
  assert.throws(() => importBonsaiPayload({ schema: 'bad', branches: [] }), /Invalid schema/);
  assert.throws(() => importBonsaiPayload({ schema: 'bonsai.v1', branches: {} }), /branches/);
});

test('importBonsaiPayload normalizes nodes, recomputes leaves, and tracks current id', () => {
  const imported = importBonsaiPayload({
    schema: 'bonsai.v1',
    activeBranchId: 'missing',
    branches: [
      {
        id: 'main',
        name: 'Main',
        nodes: [
          { id: 10, prompt: 'root', code: 'root', parentId: null, isLeaf: true, activity: 'initial' },
          { id: 11, label: 'Test 1.1', prompt: 'child', code: 'child', parentId: 10, activity: 'refactor' },
        ],
      },
    ],
  });

  assert.equal(imported.activeBranchId, 'main');
  assert.equal(imported.currentId, 11);
  assert.equal(imported.branches[0].nodes[0].isLeaf, false);
  assert.equal(imported.branches[0].nodes[1].isLeaf, true);
  assert.equal(imported.branches[0].nodes[1].label, 'Test 1.1');
  assert.deepEqual(imported.branches[0].nodes[1].tokens, { prompt: 0, completion: 0, total: 0 });
});
