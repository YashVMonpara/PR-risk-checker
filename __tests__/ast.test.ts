import { extractStructuralChanges, languageForPath, resetParsers } from '../src/ast';

afterAll(() => resetParsers());

describe('languageForPath', () => {
  it('maps JavaScript-family extensions', () => {
    expect(languageForPath('a/b/c.js')).toBe('javascript');
    expect(languageForPath('x.mjs')).toBe('javascript');
    expect(languageForPath('x.cjs')).toBe('javascript');
    expect(languageForPath('x.jsx')).toBe('javascript');
  });

  it('maps TypeScript and TSX separately', () => {
    expect(languageForPath('src/x.ts')).toBe('typescript');
    expect(languageForPath('src/x.mts')).toBe('typescript');
    expect(languageForPath('src/Component.tsx')).toBe('tsx');
  });

  it('returns null for unsupported files', () => {
    expect(languageForPath('README.md')).toBeNull();
    expect(languageForPath('image.png')).toBeNull();
    expect(languageForPath('noextension')).toBeNull();
  });
});

describe('extractStructuralChanges', () => {
  it('detects a changed exported function signature', async () => {
    const base = 'export function run(cmd) {\n  return cmd;\n}\n';
    const head = 'export function run(cmd, opts) {\n  return cmd;\n}\n';

    const changes = await extractStructuralChanges(base, head, 'src/run.ts');
    const sig = changes.find((c) => c.type === 'signature_changed');

    expect(sig).toBeDefined();
    expect(sig!.name).toBe('run');
    expect(sig!.exported).toBe(true);
    expect(sig!.before).toBe('(cmd)');
    expect(sig!.after).toBe('(cmd, opts)');
  });

  it('does not flag a function whose body changed but signature did not', async () => {
    const base = 'export function run(cmd) {\n  return 1;\n}\n';
    const head = 'export function run(cmd) {\n  return 2;\n}\n';

    const changes = await extractStructuralChanges(base, head, 'src/run.ts');
    expect(changes.filter((c) => c.type === 'signature_changed')).toHaveLength(0);
  });

  it('detects a removed export (breaking change)', async () => {
    const base = 'export function stay() {}\nexport function gone() {}\n';
    const head = 'export function stay() {}\n';

    const changes = await extractStructuralChanges(base, head, 'src/api.ts');
    const removed = changes.find((c) => c.type === 'export_removed');

    expect(removed).toBeDefined();
    expect(removed!.name).toBe('gone');
  });

  it('detects an added export', async () => {
    const base = 'export function stay() {}\n';
    const head = 'export function stay() {}\nexport function fresh() {}\n';

    const changes = await extractStructuralChanges(base, head, 'src/api.ts');
    expect(changes.find((c) => c.type === 'export_added')?.name).toBe('fresh');
  });

  it('distinguishes exported from non-exported functions', async () => {
    const base = 'function internal(a) {}\n';
    const head = 'function internal(a, b) {}\n';

    const changes = await extractStructuralChanges(base, head, 'src/x.ts');
    const sig = changes.find((c) => c.type === 'signature_changed');

    expect(sig).toBeDefined();
    expect(sig!.exported).toBe(false);
  });

  it('detects a changed class method signature', async () => {
    const base = 'export class A {\n  greet(name) { return name; }\n}\n';
    const head = 'export class A {\n  greet(name, loud) { return name; }\n}\n';

    const changes = await extractStructuralChanges(base, head, 'src/a.ts');
    const method = changes.find((c) => c.type === 'method_changed');

    expect(method).toBeDefined();
    expect(method!.name).toBe('A.greet');
  });

  it('handles TypeScript parameter type changes', async () => {
    const base = 'export function f(a: string): void {}\n';
    const head = 'export function f(a: number): void {}\n';

    const changes = await extractStructuralChanges(base, head, 'src/f.ts');
    expect(changes.find((c) => c.type === 'signature_changed')?.name).toBe('f');
  });

  it('parses TSX files', async () => {
    const base = 'export function C(props) { return <div/>; }\n';
    const head = 'export function C(props, ref) { return <div/>; }\n';

    const changes = await extractStructuralChanges(base, head, 'src/C.tsx');
    expect(changes.find((c) => c.type === 'signature_changed')?.name).toBe('C');
  });

  it('treats a new file as all-additions without crashing', async () => {
    const changes = await extractStructuralChanges(null, 'export function brandNew() {}\n', 'n.ts');
    expect(changes.find((c) => c.type === 'export_added')?.name).toBe('brandNew');
  });

  it('treats a deleted file as all-removals without crashing', async () => {
    const changes = await extractStructuralChanges('export function old() {}\n', null, 'o.ts');
    expect(changes.find((c) => c.type === 'export_removed')?.name).toBe('old');
  });

  it('returns an empty array for unsupported languages', async () => {
    expect(await extractStructuralChanges('# hi', '# there', 'README.md')).toEqual([]);
  });

  it('returns an empty array when both sides are null', async () => {
    expect(await extractStructuralChanges(null, null, 'x.ts')).toEqual([]);
  });

  it('does not throw on syntactically broken code', async () => {
    const changes = await extractStructuralChanges('export function a( {', 'function }{ (', 'b.ts');
    expect(Array.isArray(changes)).toBe(true);
  });

  it('detects arrow functions assigned to exported consts', async () => {
    const base = 'export const handler = (req) => req;\n';
    const head = 'export const handler = (req, res) => req;\n';

    const changes = await extractStructuralChanges(base, head, 'src/h.ts');
    expect(changes.find((c) => c.type === 'signature_changed')?.name).toBe('handler');
  });
});
