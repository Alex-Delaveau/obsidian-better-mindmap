/**
 * Pure layout helpers (no Obsidian / DOM imports, unit-tested in plain Node).
 *
 * - Node text: optional truncation (max length) and word wrap after N characters.
 * - Node size: width from the longest line (same 10 px/char heuristic as the
 *   original plugin), height grows by one line height per extra line.
 * - Tree layout: every child is placed on one of the four sides of its parent
 *   (north / south / east / west). Subtrees are laid out as rigid boxes so a
 *   branch never overlaps its siblings, whatever directions its own children use.
 */

export type Dir = "n" | "s" | "e" | "w";
export const DIRS: readonly Dir[] = ["n", "e", "s", "w"];

export interface LayoutNode {
    id: string;
    text: string;
    children: LayoutNode[];
    collapsed?: boolean;
    /** Radial layout: side of the root for root topics. */
    side?: "left" | "right";
    /** Explicit side of this node relative to its parent (overrides inheritance). */
    dir?: Dir;
    x?: number;
    y?: number;
}

// ------------------------------------------------------------------ text

export interface TextOptions {
    /** Truncate after this many characters (unless showFullText). */
    maxNodeLength: number;
    /** Wrap after this many characters per line; 0 disables wrapping. */
    wrapLength: number;
    /** Never truncate. */
    showFullText: boolean;
}

/** A run of text inside one line; `link` is set for wikilink text. */
export interface Span {
    text: string;
    link?: { target: string };
}

export interface DisplayText {
    /** Plain text shown in the chip (wikilink brackets removed). */
    plain: string;
    lines: string[];
    /** Same lines split into plain / link runs, for styling. */
    spans: Span[][];
    truncated: boolean;
    /** Wikilink targets found in the text, in order. */
    links: string[];
}

interface Range {
    start: number;
    end: number;
}

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/**
 * Replace `[[target|alias]]` by `alias` and `[[target]]` by its readable form
 * (`Note#Heading` → `Note > Heading`, like Obsidian), remembering where the
 * links are in the resulting plain text.
 */
export function parseWikilinks(text: string): { plain: string; links: (Range & { target: string })[] } {
    const links: (Range & { target: string })[] = [];
    let plain = "";
    let last = 0;
    WIKILINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK_RE.exec(text))) {
        plain += text.slice(last, m.index);
        const target = m[1].trim();
        const label = (m[2] ?? target.replace(/#\^?/g, " > ")).trim() || target;
        links.push({ start: plain.length, end: plain.length + label.length, target });
        plain += label;
        last = m.index + m[0].length;
    }
    plain += text.slice(last);
    return { plain, links };
}

/**
 * Greedy word wrap returning [start, end) ranges into `text`, so styling of
 * sub-ranges survives wrapping. Words longer than `width` are hard-split.
 */
export function wrapRanges(text: string, width: number): Range[] {
    if (!width || width <= 0 || text.length <= width) return [{ start: 0, end: text.length }];
    const words: Range[] = [];
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) words.push({ start: m.index, end: m.index + m[0].length });
    if (words.length === 0) return [{ start: 0, end: text.length }];

    const lines: Range[] = [];
    let cur: Range | null = null;
    const len = (r: Range) => r.end - r.start;
    for (const word of words) {
        let w: Range = { ...word };
        while (len(w) > 0) {
            if (cur && cur.end - cur.start + 1 + len(w) <= width) {
                cur.end = w.end;
                break;
            }
            if (len(w) <= width) {
                if (cur) lines.push(cur);
                cur = { ...w };
                break;
            }
            // Word longer than a line: fill the current line if a useful chunk fits.
            const room = cur ? width - (cur.end - cur.start) - 1 : 0;
            if (cur && room >= 4) {
                cur.end = w.start + room;
                w = { start: w.start + room, end: w.end };
            }
            if (cur) lines.push(cur);
            cur = null;
            if (len(w) > width) {
                lines.push({ start: w.start, end: w.start + width });
                w = { start: w.start + width, end: w.end };
            } else {
                cur = { ...w };
                break;
            }
        }
    }
    if (cur) lines.push(cur);
    return lines;
}

/** Greedy word wrap; words longer than `width` are hard-split. */
export function wrapLines(text: string, width: number): string[] {
    return wrapRanges(text, width).map((r) => text.slice(r.start, r.end));
}

export function displayText(text: string, opts: TextOptions): DisplayText {
    const parsed = parseWikilinks(text);
    let shown = parsed.plain;
    let truncated = false;
    if (!opts.showFullText && shown.length > opts.maxNodeLength) {
        shown = shown.substring(0, opts.maxNodeLength) + "...";
        truncated = true;
    }
    const ranges = wrapRanges(shown, opts.wrapLength);
    const linkLimit = truncated ? opts.maxNodeLength : shown.length;
    const spans = ranges.map((r) => {
        const out: Span[] = [];
        let pos = r.start;
        for (const l of parsed.links) {
            const s = Math.max(l.start, r.start);
            const e = Math.min(l.end, r.end, linkLimit);
            if (e <= s) continue;
            if (s > pos) out.push({ text: shown.slice(pos, s) });
            out.push({ text: shown.slice(s, e), link: { target: l.target } });
            pos = e;
        }
        if (pos < r.end) out.push({ text: shown.slice(pos, r.end) });
        return out.length ? out : [{ text: "" }];
    });
    return {
        plain: parsed.plain,
        lines: ranges.map((r) => shown.slice(r.start, r.end)),
        spans,
        truncated,
        links: parsed.links.map((l) => l.target),
    };
}

// ------------------------------------------------------------------ size

export const NODE_HEIGHT = 40;
export const LINE_HEIGHT = 18;
/** Baseline of the first text line inside a node (original plugin value). */
export const FIRST_BASELINE = 25;
const MIN_WIDTH = 120;
const BASE_WIDTH = 40;
const CHAR_WIDTH = 10;

export interface Size {
    w: number;
    h: number;
}

export function sizeOfLines(lines: string[]): Size {
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
    return {
        w: Math.max(MIN_WIDTH, BASE_WIDTH + longest * CHAR_WIDTH),
        h: NODE_HEIGHT + Math.max(0, lines.length - 1) * LINE_HEIGHT,
    };
}

// ------------------------------------------------------------------ layout

/** Horizontal distance between a parent and its east/west children (original value). */
export const BRANCH_GAP = 80;
/** Vertical distance between a parent and its north/south children. */
export const VERTICAL_GAP = 50;
/** Gap between neighbouring sibling subtrees (original value). */
export const SIBLING_GAP = 30;
/** Padding around each sibling subtree on the stacking axis (original slot = 40 + 2×10). */
export const SLOT_PAD = 10;

interface Box {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export interface LayoutOptions {
    radial: boolean;
    rootX: number;
    rootY: number;
    sizeOf: (node: LayoutNode) => Size;
}

export interface LayoutResult {
    /** Side of each laid-out node relative to its parent (root: "e"). */
    dirOf: Map<string, Dir>;
}

/** Default direction for a child that has no explicit `dir`. */
export function inheritedDir(
    child: LayoutNode,
    parentIsRoot: boolean,
    parentDir: Dir,
    radial: boolean
): Dir {
    // A child can never sit on the side facing its grandparent (it would land on the
    // parent's own connector): such a stale `dir` falls back to the parent's growth.
    if (child.dir && (parentIsRoot || child.dir !== OPPOSITE[parentDir])) return child.dir;
    if (parentIsRoot) return radial && child.side === "left" ? "w" : "e";
    return parentDir;
}

/** Side of a non-root node that faces its own parent: not available to its children. */
export function blockedDir(nodeDir: Dir, isRoot: boolean): Dir | null {
    return isRoot ? null : OPPOSITE[nodeDir];
}

const CLOCKWISE: readonly Dir[] = ["n", "e", "s", "w"];

/**
 * Where a child placed on side `d` goes when its parent's growth changes from
 * `from` to `to`: forward stays forward; when the branch is mirrored (east ↔ west,
 * north ↔ south) lateral children keep their side; when it turns by 90° they turn
 * with it, so the branch keeps its shape.
 */
export function mapDir(d: Dir, from: Dir, to: Dir): Dir {
    if (from === to) return d;
    if (d === from || d === OPPOSITE[from]) return to;
    if (to === OPPOSITE[from]) return d;
    const k = (CLOCKWISE.indexOf(to) - CLOCKWISE.indexOf(from) + 4) % 4;
    return CLOCKWISE[(CLOCKWISE.indexOf(d) + k) % 4];
}

/**
 * After `node` moved from growing `from` to growing `to`, rewrite the explicit
 * sides of its descendants so the branch keeps its shape and no child ends up
 * facing back to its grandparent. `oldDirOf` holds the sides before the move.
 */
export function reorientSubtree(node: LayoutNode, from: Dir, to: Dir, oldDirOf: Map<string, Dir>): void {
    for (const child of node.children) {
        const oldChild = oldDirOf.get(child.id) ?? child.dir ?? from;
        let newChild: Dir;
        if (child.dir) {
            newChild = mapDir(oldChild, from, to);
            if (newChild === to) delete child.dir;
            else child.dir = newChild;
        } else {
            newChild = to;
        }
        reorientSubtree(child, oldChild, newChild, oldDirOf);
    }
}

const bounds = (rects: Box[]): Box =>
    rects.reduce(
        (a, r) => ({
            minX: Math.min(a.minX, r.minX),
            minY: Math.min(a.minY, r.minY),
            maxX: Math.max(a.maxX, r.maxX),
            maxY: Math.max(a.maxY, r.maxY),
        }),
        { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    );

const shift = (r: Box, dx: number, dy: number): Box => ({
    minX: r.minX + dx,
    minY: r.minY + dy,
    maxX: r.maxX + dx,
    maxY: r.maxY + dy,
});

/**
 * Lay out the tree. Sets `x`/`y` (top-left) on every visible node and returns
 * the side each node sits on relative to its parent.
 *
 * Children on one side of a chip are spread symmetrically around it (the chips,
 * not their whole branches, are centred on the parent). Branches are kept from
 * overlapping by checking the actual chip rectangles, so a branch only moves
 * away from its parent when something really is in the way.
 */
export function layoutTree(root: LayoutNode, opts: LayoutOptions): LayoutResult {
    const dirOf = new Map<string, Dir>();
    const rel = new Map<string, { dx: number; dy: number }>();

    /** Returns the rectangles of every visible chip of the subtree, relative to the node (first = the node). */
    const local = (node: LayoutNode, ownDir: Dir, isRoot: boolean): Box[] => {
        dirOf.set(node.id, ownDir);
        const { w, h } = opts.sizeOf(node);
        const self: Box = { minX: 0, minY: 0, maxX: w, maxY: h };
        const placed: Box[] = [self];
        if (node.collapsed || node.children.length === 0) return placed;

        const groups: Record<Dir, { node: LayoutNode; rects: Box[]; box: Box; size: Size }[]> = { n: [], s: [], e: [], w: [] };
        for (const child of node.children) {
            const d = inheritedDir(child, isRoot, ownDir, opts.radial);
            const rects = local(child, d, false);
            groups[d].push({ node: child, rects, box: bounds(rects), size: opts.sizeOf(child) });
        }

        const accept = (child: LayoutNode, rects: Box[], dx: number, dy: number) => {
            rel.set(child.id, { dx, dy });
            for (const r of rects) placed.push(shift(r, dx, dy));
        };
        const overlapsY = (a: Box, b: Box, margin: number) => a.minY < b.maxY + margin && a.maxY > b.minY - margin;
        const overlapsX = (a: Box, b: Box, margin: number) => a.minX < b.maxX + margin && a.maxX > b.minX - margin;

        // East / west: vertical stacks. Each branch keeps its own slot (no overlap
        // between siblings); the stack is centred on the parent using the chips.
        for (const d of ["e", "w"] as const) {
            const items = groups[d];
            if (!items.length) continue;
            const others = placed.slice();
            let cur = 0;
            const dys = items.map(({ box: b }) => {
                const dy = cur + SLOT_PAD - b.minY;
                cur += b.maxY - b.minY + 2 * SLOT_PAD + SIBLING_GAP;
                return dy;
            });
            const first = dys[0] + items[0].size.h / 2;
            const last = dys[dys.length - 1] + items[items.length - 1].size.h / 2;
            const offset = h / 2 - (first + last) / 2;
            items.forEach(({ node: c, rects, size }, i) => {
                const dy = dys[i] + offset;
                let dx = d === "e" ? w + BRANCH_GAP : -BRANCH_GAP - size.w;
                for (const r1 of rects) {
                    const r = shift(r1, 0, dy);
                    for (const r2 of others) {
                        const gap = r2 === self ? BRANCH_GAP : SIBLING_GAP;
                        if (!overlapsY(r, r2, r2 === self ? SLOT_PAD : 0)) continue;
                        if (d === "e") dx = Math.max(dx, r2.maxX + gap - r.minX);
                        else dx = Math.min(dx, r2.minX - gap - r.maxX);
                    }
                }
                accept(c, rects, dx, dy);
            });
        }

        // North / south: horizontal rows, chips centred on the parent and aligned on
        // one line; the whole row moves away from the parent only if it would collide.
        for (const d of ["n", "s"] as const) {
            const items = groups[d];
            if (!items.length) continue;
            const others = placed.slice();
            let cur = 0;
            const dxs = items.map(({ box: b }) => {
                const dx = cur + SLOT_PAD - b.minX;
                cur += b.maxX - b.minX + 2 * SLOT_PAD + SIBLING_GAP;
                return dx;
            });
            const first = dxs[0] + items[0].size.w / 2;
            const last = dxs[dxs.length - 1] + items[items.length - 1].size.w / 2;
            const offset = w / 2 - (first + last) / 2;
            // Base: chips at VERTICAL_GAP from the parent, then push further if needed.
            const base = items.map(({ size }) => (d === "n" ? -VERTICAL_GAP - size.h : h + VERTICAL_GAP));
            let push = 0;
            items.forEach(({ rects }, i) => {
                for (const r1 of rects) {
                    const r = shift(r1, dxs[i] + offset, base[i]);
                    for (const r2 of others) {
                        const gap = r2 === self ? VERTICAL_GAP : SIBLING_GAP;
                        if (!overlapsX(r, r2, r2 === self ? SLOT_PAD : 0)) continue;
                        if (d === "n") push = Math.max(push, r.maxY - (r2.minY - gap));
                        else push = Math.max(push, r2.maxY + gap - r.minY);
                    }
                }
            });
            items.forEach(({ node: c, rects }, i) => {
                accept(c, rects, dxs[i] + offset, base[i] + (d === "n" ? -push : push));
            });
        }
        return placed;
    };

    local(root, "e", true);

    const assign = (node: LayoutNode, x: number, y: number) => {
        node.x = x;
        node.y = y;
        if (node.collapsed) return;
        for (const child of node.children) {
            const r = rel.get(child.id);
            if (r) assign(child, x + r.dx, y + r.dy);
        }
    };
    assign(root, opts.rootX, opts.rootY);
    return { dirOf };
}

// ------------------------------------------------------------------ geometry helpers

export interface Point {
    x: number;
    y: number;
}

/** Point on the edge of a node facing `dir` (relative to the node's top-left). */
export function anchor(size: Size, dir: Dir): Point {
    switch (dir) {
        case "e":
            return { x: size.w, y: size.h / 2 };
        case "w":
            return { x: 0, y: size.h / 2 };
        case "n":
            return { x: size.w / 2, y: 0 };
        case "s":
            return { x: size.w / 2, y: size.h };
    }
}

export const OPPOSITE: Record<Dir, Dir> = { n: "s", s: "n", e: "w", w: "e" };

/** Cubic connector from a parent edge to a child edge (child placed on `dir`). */
export function connectorPath(parent: Point & Size, child: Point & Size, dir: Dir): string {
    const a = anchor(parent, dir);
    const b = anchor(child, OPPOSITE[dir]);
    const x1 = parent.x + a.x;
    const y1 = parent.y + a.y;
    const x2 = child.x + b.x;
    const y2 = child.y + b.y;
    if (dir === "e" || dir === "w") {
        const mx = x1 + (x2 - x1) / 2;
        return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
    }
    const my = y1 + (y2 - y1) / 2;
    return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
}

/** Centre of the drop "pole" on each side of a node (relative to its top-left). */
export const POLE_OFFSET = 18;
export function poleCenter(size: Size, dir: Dir): Point {
    const a = anchor(size, dir);
    switch (dir) {
        case "e":
            return { x: a.x + POLE_OFFSET, y: a.y };
        case "w":
            return { x: a.x - POLE_OFFSET, y: a.y };
        case "n":
            return { x: a.x, y: a.y - POLE_OFFSET };
        case "s":
            return { x: a.x, y: a.y + POLE_OFFSET };
    }
}

/** Nearest pole within `radius` of a point (relative coordinates), or null. */
export function hitPole(
    size: Size,
    relX: number,
    relY: number,
    radius: number,
    prefer?: Dir | null,
    exclude?: Dir | null
): Dir | null {
    let best: Dir | null = null;
    let bestDist = Infinity;
    for (const d of DIRS) {
        if (d === exclude) continue;
        const p = poleCenter(size, d);
        const dist = Math.hypot(relX - p.x, relY - p.y);
        // Sticky: the currently active pole keeps a larger radius.
        const r = d === prefer ? radius * 1.7 : radius;
        if (dist <= r && dist < bestDist) {
            best = d;
            bestDist = dist;
        }
    }
    return best;
}
