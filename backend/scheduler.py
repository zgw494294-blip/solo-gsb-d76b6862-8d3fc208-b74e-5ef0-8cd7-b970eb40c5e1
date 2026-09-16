"""调度计算：拓扑排序、级联重算、成环检测与冲突链追溯。"""
from collections import defaultdict, deque


class CycleError(Exception):
    """依赖图中存在环。"""


def topo_order(cue_ids, edges):
    """edges: [(cue_id, depends_on), ...]，返回前置在前的拓扑序。"""
    indegree = {cid: 0 for cid in cue_ids}
    followers = defaultdict(list)
    for cue_id, depends_on in edges:
        if cue_id in indegree and depends_on in indegree:
            followers[depends_on].append(cue_id)
            indegree[cue_id] += 1
    queue = deque(sorted(cid for cid in cue_ids if indegree[cid] == 0))
    order = []
    while queue:
        node = queue.popleft()
        order.append(node)
        for nxt in followers[node]:
            indegree[nxt] -= 1
            if indegree[nxt] == 0:
                queue.append(nxt)
    if len(order) != len(cue_ids):
        raise CycleError("依赖关系存在环")
    return order


def would_cycle(edges, cue_id, depends_on):
    """新增边 cue_id -> depends_on 是否成环：沿依赖边从 depends_on 出发能否到达 cue_id。"""
    if cue_id == depends_on:
        return True
    preds = defaultdict(list)
    for c, d in edges:
        preds[c].append(d)
    stack, seen = [depends_on], set()
    while stack:
        node = stack.pop()
        if node == cue_id:
            return True
        if node in seen:
            continue
        seen.add(node)
        stack.extend(preds[node])
    return False


def compute_schedule(cues, edges):
    """按拓扑顺序级联重算每条提示的开始时间。

    cues:  {id: {"duration": int, "locked_start": int | None}}
    edges: [(cue_id, depends_on, delay), ...]
    返回:  {id: {"start", "end", "earliest", "conflict", "conflict_chain"}}

    规则：
    - 未锁定提示 start = max(前置 end + delay)，无前置时为 0；
    - 锁定提示始终保留锁定值；若锁定值 < 依赖允许的最早时间则标记冲突，
      并沿“关键前置”（决定 earliest 的前置）向上追溯完整冲突链。
    """
    order = topo_order(list(cues), [(c, d) for c, d, _ in edges])
    preds = defaultdict(list)  # cue_id -> [(depends_on, delay)]
    for cue_id, depends_on, delay in edges:
        preds[cue_id].append((depends_on, delay))

    result = {}
    binding_preds = {}  # cue_id -> [决定其 earliest 的前置 id]

    for cid in order:
        earliest = 0
        binding = []
        for p, delay in preds[cid]:
            cand = result[p]["end"] + delay
            if cand > earliest:
                earliest = cand
                binding = [p]
            elif cand == earliest:
                binding.append(p)
        locked = cues[cid]["locked_start"]
        start = locked if locked is not None else earliest
        result[cid] = {
            "start": start,
            "end": start + cues[cid]["duration"],
            "earliest": earliest,
            "conflict": locked is not None and locked < earliest,
            "conflict_chain": [],
        }
        binding_preds[cid] = binding

    def chain_of(cid):
        """从 cid 的关键前置向上追溯；前置被锁定时其开始时间不再受更上游影响，链条终止。"""
        chain, visited, stack = [], set(), list(binding_preds[cid])
        while stack:
            p = stack.pop()
            if p in visited:
                continue
            visited.add(p)
            chain.append(p)
            if cues[p]["locked_start"] is None:
                stack.extend(binding_preds[p])
        return chain

    for cid in order:
        if result[cid]["conflict"]:
            result[cid]["conflict_chain"] = chain_of(cid)
    return result
