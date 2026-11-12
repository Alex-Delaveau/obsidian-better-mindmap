import { test } from "node:test";
import assert from "node:assert/strict";
import * as L from "../src/shared/layout";

const opts = (o: Partial<L.TextOptions> = {}): L.TextOptions => ({
    maxNodeLength: 20,
    wrapLength: 0,
    showFullText: false,
    ...o,
});

// ------------------------------------------------------------------ text

test("no wrap, truncation identical to the original plugin", () => {
    const d = L.displayText("Spécialisation spatio-temporelle", opts());
    assert.deepEqual(d.lines, ["Spécialisation spati..."]);
    assert.equal(d.truncated, true);
    assert.deepEqual(L.sizeOfLines(d.lines), { w: 40 + 23 * 10, h: 40 });
});

test("wrap after N characters, at word boundaries", () => {
    const text = "Giga models for learning multimodal data representations";
    const d = L.displayText(text, opts({ wrapLength: 20, showFullText: true }));
    assert.deepEqual(d.lines, ["Giga models for", "learning multimodal", "data representations"]);
    assert.ok(d.lines.every((l) => l.length <= 20));
    assert.equal(d.truncated, false);
    assert.deepEqual(L.sizeOfLines(d.lines), { w: 40 + 20 * 10, h: 40 + 2 * 18 });
});

test("truncation then wrap when full text is off", () => {
    const d = L.displayText("aaaa bbbb cccc dddd eeee ffff", opts({ maxNodeLength: 12, wrapLength: 10 }));
    assert.deepEqual(d.lines, ["aaaa bbbb", "cc..."]);
    assert.equal(d.truncated, true);
});

test("long words are hard-split", () => {
    assert.deepEqual(L.wrapLines("abcdefghijklmnopqrstuvwxyz", 10), ["abcdefghij", "klmnopqrst", "uvwxyz"]);
    assert.deepEqual(L.wrapLines("see abcdefghijklmnop", 10), ["see abcdef", "ghijklmnop"]);
    assert.ok(L.wrapLines("x".repeat(95), 30).every((l) => l.length <= 30));
});

test("short text and empty text", () => {
    assert.deepEqual(L.displayText("WP2", opts({ wrapLength: 30 })).lines, ["WP2"]);
    assert.deepEqual(L.displayText("", opts({ wrapLength: 30 })).lines, [""]);
    assert.deepEqual(L.sizeOfLines([""]), { w: 120, h: 40 });
});

// ------------------------------------------------------------------ wikilinks

test("wikilinks are shown without brackets and marked as links", () => {
    const d = L.displayText("[[Multi-SenGE]]", opts());
    assert.deepEqual(d.lines, ["Multi-SenGE"]);
    assert.deepEqual(d.spans, [[{ text: "Multi-SenGE", link: { target: "Multi-SenGE" } }]]);
    assert.deepEqual(d.links, ["Multi-SenGE"]);
    // Width follows the visible text, not the raw markdown.
    assert.equal(L.sizeOfLines(d.lines).w, 40 + 11 * 10);
});

test("alias, heading and surrounding text", () => {
    assert.equal(L.parseWikilinks("[[Note|Alias]]").plain, "Alias");
    assert.equal(L.parseWikilinks("[[Note#Méthodes]]").plain, "Note > Méthodes");
    const d = L.displayText("Voir [[Multi-SenGE]] puis la suite", opts({ wrapLength: 16, showFullText: true }));
    assert.deepEqual(d.lines, ["Voir Multi-SenGE", "puis la suite"]);
    assert.deepEqual(d.spans[0], [{ text: "Voir " }, { text: "Multi-SenGE", link: { target: "Multi-SenGE" } }]);
    assert.deepEqual(d.spans[1], [{ text: "puis la suite" }]);
});

test("a link split by wrapping keeps its style on both lines", () => {
    const d = L.displayText("[[Spatio temporal specialisation]]", opts({ wrapLength: 14, showFullText: true }));
    assert.deepEqual(d.lines, ["Spatio", "temporal", "specialisation"]);
    assert.ok(d.spans.every((line) => line.every((s) => s.link?.target === "Spatio temporal specialisation")));
});

test("truncation never styles the ellipsis as a link", () => {
    const d = L.displayText("[[A very long linked note name]]", opts({ maxNodeLength: 10 }));
    assert.deepEqual(d.spans, [[{ text: "A very lon", link: { target: "A very long linked note name" } }, { text: "..." }]]);
});

// ------------------------------------------------------------------ layout

const size = (n: L.LayoutNode) => L.sizeOfLines([n.text]);
const node = (id: string, children: L.LayoutNode[] = [], extra: Partial<L.LayoutNode> = {}): L.LayoutNode => ({
    id,
    text: id,
    children,
    ...extra,
});
const rect = (n: L.LayoutNode) => {
    const s = size(n);
    return { x: n.x!, y: n.y!, w: s.w, h: s.h };
};
const overlaps = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const all = (n: L.LayoutNode): L.LayoutNode[] => [n, ...(n.collapsed ? [] : n.children.flatMap(all))];

test("plain trees keep the original plugin positions", () => {
    // Original: children at x + width + 80, leaf slot 60, sibling gap 30.
    const root = node("root", [node("a"), node("b"), node("c")]);
    L.layoutTree(root, { radial: false, rootX: 100, rootY: 300, sizeOf: size });
    assert.deepEqual([root.x, root.y], [100, 300]);
    const cx = 100 + 120 + 80;
    assert.deepEqual(root.children.map((c) => [c.x, c.y]), [
        [cx, 300 - 90],
        [cx, 300],
        [cx, 300 + 90],
    ]);
});

test("radial layout keeps left topics on the left", () => {
    const root = node("root", [node("r1", [], { side: "right" }), node("l1", [node("l2")], { side: "left" })]);
    const res = L.layoutTree(root, { radial: true, rootX: 500, rootY: 300, sizeOf: size });
    const [r1, l1] = root.children;
    assert.equal(r1.x, 500 + 120 + 80);
    assert.equal(l1.x, 500 - 80 - 120);
    assert.equal(l1.children[0].x, l1.x! - 80 - 120);
    assert.equal(res.dirOf.get("l2"), "w");
});

test("children on the four sides of a node", () => {
    // The root accepts children on its four sides (other chips lose the side facing their parent).
    const p = node("root", [node("east"), node("north", [], { dir: "n" }), node("south", [], { dir: "s" }), node("west", [], { dir: "w" })]);
    const res = L.layoutTree(p, { radial: false, rootX: 0, rootY: 0, sizeOf: size });
    const [e, n, s, w] = p.children;
    const P = rect(p);
    assert.ok(rect(e).x >= P.x + P.w + 80, "east is right");
    assert.ok(rect(w).x + 120 <= P.x - 80, "west is left");
    assert.ok(rect(n).y + 40 <= P.y - 50 + 0.001, "north is above");
    assert.ok(rect(s).y >= P.y + P.h + 50 - 0.001, "south is below");
    assert.equal(rect(n).x + 60, P.x + 60, "north centred");
    assert.deepEqual(["east", "north", "south", "west"].map((id) => res.dirOf.get(id)), ["e", "n", "s", "w"]);
});

test("grandchildren inherit their parent's side", () => {
    const n = node("n", [node("n1"), node("n2")], { dir: "n" });
    const root = node("root", [n]);
    const res = L.layoutTree(root, { radial: false, rootX: 0, rootY: 500, sizeOf: size });
    assert.equal(res.dirOf.get("n1"), "n");
    assert.ok(n.children.every((c) => c.y! < n.y!));
    assert.ok(n.children[0].x! < n.children[1].x!, "row left to right in order");
});

test("no overlaps in a mixed tree", () => {
    const big = (id: string, k: number, dir?: L.Dir) =>
        node(id, Array.from({ length: k }, (_, i) => node(`${id}-${i}`, [node(`${id}-${i}-x`)])), dir ? { dir } : {});
    const root = node("root", [
        big("A", 4),
        big("B", 3, "n"),
        big("C", 3, "s"),
        big("D", 2, "w"),
        node("E", [big("E1", 3, "n"), big("E2", 3, "s"), big("E3", 2)]),
    ]);
    L.layoutTree(root, { radial: true, rootX: 500, rootY: 300, sizeOf: size });
    const rects = all(root).map((n) => ({ id: n.id, r: rect(n) }));
    for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++)
            assert.ok(!overlaps(rects[i].r, rects[j].r), `${rects[i].id} overlaps ${rects[j].id}`);
});

test("tall multi-line chips push their siblings apart", () => {
    const tall = (n: L.LayoutNode) => (n.id === "tall" ? { w: 200, h: 40 + 4 * 18 } : size(n));
    const root = node("root", [node("a"), node("tall"), node("b")]);
    L.layoutTree(root, { radial: false, rootX: 0, rootY: 0, sizeOf: tall });
    const [a, t, b] = root.children;
    assert.ok(a.y! + 40 + 30 <= t.y!, "a above tall");
    assert.ok(t.y! + 112 + 30 <= b.y!, "b below tall");
});

test("children are symmetric around their parent (user sketch)", () => {
    // root → three east children; the top one has three north children.
    const top = node("top", [node("n1", [], { dir: "n" }), node("n2", [], { dir: "n" }), node("n3", [], { dir: "n" })]);
    const root = node("root", [top, node("mid"), node("bottom")]);
    L.layoutTree(root, { radial: false, rootX: 0, rootY: 500, sizeOf: size });
    const cy = (n: L.LayoutNode) => n.y! + 20;
    const cx = (n: L.LayoutNode) => n.x! + 60;
    const [, mid, bottom] = root.children;
    assert.equal(cy(mid), cy(root), "middle child level with the parent");
    assert.equal(cy(root) - cy(top), cy(bottom) - cy(root), "east column symmetric");
    assert.equal(top.x, 120 + 80, "original branch gap kept");
    const [n1, n2, n3] = top.children;
    assert.equal(cx(n2), cx(top), "north row centred on its parent");
    assert.equal(cx(top) - cx(n1), cx(n3) - cx(top), "north row symmetric");
    assert.ok([n1, n2, n3].every((n) => n.y === n1.y), "north chips on one line");
});

test("an even number of children straddles the parent", () => {
    const root = node("root", [node("a"), node("b")]);
    L.layoutTree(root, { radial: false, rootX: 0, rootY: 0, sizeOf: size });
    assert.deepEqual(root.children.map((c) => c.y), [-45, 45]);
});

test("collapsed subtrees are not laid out", () => {
    const root = node("root", [node("a", [node("hidden")], { collapsed: true })]);
    L.layoutTree(root, { radial: false, rootX: 0, rootY: 0, sizeOf: size });
    assert.equal(root.children[0].children[0].x, undefined);
});

// ------------------------------------------------------------------ reorientation

test("a child never sits between its parent and its grandparent", () => {
    // A → B (south) → C (stale "north": would point back to A).
    const c = node("C", [], { dir: "n" });
    const b = node("B", [c], { dir: "s" });
    const root = node("A", [b]);
    const res = L.layoutTree(root, { radial: false, rootX: 0, rootY: 0, sizeOf: size });
    assert.equal(res.dirOf.get("C"), "s", "falls back to the parent's growth");
    assert.ok(c.y! > b.y!, "C below B, not between A and B");
    assert.equal(L.blockedDir("s", false), "n");
    assert.equal(L.blockedDir("s", true), null);
});

test("moving a branch turns its children with it", () => {
    assert.equal(L.mapDir("n", "e", "s"), "e", "east→south: north child turns to east");
    assert.equal(L.mapDir("s", "e", "s"), "w");
    assert.equal(L.mapDir("n", "e", "w"), "n", "mirror: lateral side kept");
    assert.equal(L.mapDir("e", "e", "n"), "n", "forward stays forward");
    assert.equal(L.mapDir("w", "e", "s"), "s", "stale backward side becomes forward");

    // B was east of A with C north and D east (inherited); B moves south of A.
    const d2 = node("D2", [], { dir: "n" });
    const c = node("C", [d2], { dir: "n" });
    const d = node("D");
    const b = node("B", [c, d]);
    const old = new Map<string, L.Dir>([["B", "e"], ["C", "n"], ["D", "e"], ["D2", "n"]]);
    b.dir = "s";
    L.reorientSubtree(b, "e", "s", old);
    assert.equal(c.dir, "e", "C turned from north to east");
    assert.equal(d.dir, undefined, "D still follows B");
    assert.equal(d2.dir, undefined, "D2 continued its parent's growth, still does");
    const root = node("A", [b]);
    const res = L.layoutTree(root, { radial: false, rootX: 0, rootY: 0, sizeOf: size });
    assert.deepEqual(["B", "C", "D", "D2"].map((id) => res.dirOf.get(id)), ["s", "e", "s", "e"]);
});

// ------------------------------------------------------------------ geometry

test("connectors start and end on the facing edges", () => {
    const p = { x: 0, y: 0, w: 120, h: 40 };
    const c = { x: 200, y: 100, w: 120, h: 40 };
    assert.match(L.connectorPath(p, c, "e"), /^M 120 20 .* 200 120$/);
    const n = { x: 0, y: -100, w: 120, h: 40 };
    assert.match(L.connectorPath(p, n, "n"), /^M 60 0 .* 60 -60$/);
});

test("pole hit-testing is sticky for the active pole", () => {
    const s = { w: 120, h: 40 };
    const e = L.poleCenter(s, "e");
    assert.equal(L.hitPole(s, e.x, e.y, 24), "e");
    assert.equal(L.hitPole(s, e.x + 30, e.y, 24), null);
    assert.equal(L.hitPole(s, e.x + 30, e.y, 24, "e"), "e");
    assert.equal(L.hitPole(s, 60, -18, 24), "n");
    assert.equal(L.hitPole(s, 60, 20, 10), null, "centre of the chip is not a pole");
});
