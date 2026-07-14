import { getActivityColor } from './server-utils';

export type LizardMetrics = any;

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface CodeNode {
  id: number;
  label?: string;
  prompt: string;
  code: string;
  parentId: number | null;
  children: CodeNode[];
  durationMs?: number;
  tokens?: TokenUsage;
  reasoning?: string;
  lizard?: LizardMetrics;
  isLeaf: boolean;
  activity: string;
}

export interface Branch {
  id: string;
  name: string;
  nodes: CodeNode[];
}

export interface GraphData {
  nodes: object[];
  edges: object[];
}

export interface ImportedBonsaiState {
  branches: Branch[];
  activeBranchId: string | null;
  currentId: number;
}

export function createGraphFromBranch(branch?: Branch): GraphData {
  if (!branch) { return { nodes: [], edges: [] }; }

  const metricNodes = branch.nodes.filter(n => n.parentId !== null);
  const completionVals = metricNodes.map(n => n.tokens?.completion ?? 0);
  const minTokens = completionVals.length ? Math.min(...completionVals) : 0;
  const maxTokens = completionVals.length ? Math.max(...completionVals) : 0;
  const durationVals = metricNodes.map(n => n.durationMs ?? 0);
  const minDuration = durationVals.length ? Math.min(...durationVals) : 0;
  const maxDuration = durationVals.length ? Math.max(...durationVals) : 0;

  return {
    nodes: branch.nodes.map(s => {
      const tokens = s.tokens?.completion ?? 0;
      const size = (minTokens === maxTokens)
        ? 80
        : 40 + ((tokens - minTokens) / (maxTokens - minTokens)) * (120 - 40);

      const duration = s.durationMs ?? 0;
      const t = (maxDuration === minDuration)
        ? 0
        : (duration - minDuration) / (maxDuration - minDuration);
      const r = Math.round(255 * t);
      const b = Math.round(255 * (1 - t));
      const timeColor = `rgb(${r},0,${b})`;
      const activityColor = getActivityColor(s.activity);

      return {
        data: {
          id: 'n' + s.id,
          label: s.label || '#' + s.id,
          code: s.code,
          prompt: s.prompt,
          activity: s.activity,
          reasoning: s.reasoning,
          size: Math.round(size),
          activityColor,
          timeColor,
          duration,
          durationNorm: t
        }
      };
    }),
    edges: branch.nodes
      .filter(n => n.parentId !== null)
      .map(n => ({ data: { source: 'n' + n.parentId, target: 'n' + n.id } }))
  };
}

export function recomputeLeafFlags(branch: Branch): void {
  const childCount = new Map<number, number>();
  for (const n of branch.nodes) { childCount.set(n.id, 0); }
  for (const n of branch.nodes) {
    if (n.parentId != null && childCount.has(n.parentId)) {
      childCount.set(n.parentId, (childCount.get(n.parentId) || 0) + 1);
    }
  }
  for (const n of branch.nodes) {
    n.isLeaf = (childCount.get(n.id) || 0) === 0;
  }
}

export function findNodeAndDescendantIds(branch: Branch, rootId: number): Set<number> {
  const root = branch.nodes.find(n => n.id === rootId);
  if (!root) { return new Set<number>(); }

  const toDelete = new Set<number>([root.id]);
  const collect = (nodeId: number): void => {
    for (const child of branch.nodes.filter(n => n.parentId === nodeId)) {
      toDelete.add(child.id);
      collect(child.id);
    }
  };
  collect(root.id);
  return toDelete;
}

export function trimBranchAtNode(branch: Branch, rootId: number): Set<number> {
  const toDelete = findNodeAndDescendantIds(branch, rootId);
  if (toDelete.size === 0) { return toDelete; }

  branch.nodes = branch.nodes.filter(n => !toDelete.has(n.id));
  recomputeLeafFlags(branch);
  return toDelete;
}

export function importBonsaiPayload(payload: any): ImportedBonsaiState {
  if (!payload || payload.schema !== 'bonsai.v1') {
    throw new Error('Invalid schema. Expected "bonsai.v1".');
  }
  if (!Array.isArray(payload.branches)) {
    throw new Error('Invalid file: "branches" must be an array.');
  }

  const importedBranches: Branch[] = payload.branches.map((b: any) => ({
    id: String(b.id ?? 'main'),
    name: String(b.name ?? 'Main'),
    nodes: Array.isArray(b.nodes) ? b.nodes.map((n: any) => ({
      id: Number(n.id),
      label: typeof n.label === 'string' ? n.label : undefined,
      prompt: String(n.prompt ?? ''),
      code: String(n.code ?? ''),
      parentId: (n.parentId === null || n.parentId === undefined) ? null : Number(n.parentId),
      children: [],
      durationMs: typeof n.durationMs === 'number' ? n.durationMs : 0,
      tokens: n.tokens ?? { prompt: 0, completion: 0, total: 0 },
      reasoning: typeof n.reasoning === 'string' ? n.reasoning : undefined,
      lizard: n.lizard,
      isLeaf: Boolean(n.isLeaf),
      activity: String(n.activity ?? 'other')
    })) : []
  }));

  for (const br of importedBranches) { recomputeLeafFlags(br); }

  const requestedActiveId = typeof payload.activeBranchId === 'string' ? payload.activeBranchId : null;
  const activeBranchId = importedBranches.some(b => b.id === requestedActiveId)
    ? requestedActiveId
    : (importedBranches[0]?.id ?? null);

  const allNodeIds = importedBranches.flatMap(b => b.nodes.map(n => n.id)).filter(Number.isFinite);
  const currentId = allNodeIds.length ? Math.max(...allNodeIds) : 0;

  return { branches: importedBranches, activeBranchId, currentId };
}
