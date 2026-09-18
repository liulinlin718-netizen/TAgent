import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { invalidateBrowserSnapshot, resolveBrowserReference, takeBrowserSnapshot } from '../tools/browser-snapshot.js';

function fixture() {
  let url = 'https://fixture.example/';
  const elements = ['link', 'button', 'button', 'textbox'].map((role, index) => ({
    role, name: role === 'button' ? 'Same label' : `${role} ${index}`, href: role === 'link' ? 'https://fixture.example/details' : '',
    tag: role === 'link' ? 'a' : role === 'button' ? 'button' : 'input', inputType: role === 'textbox' ? 'text' : '',
    fieldName: '', formAction: '', formMethod: '', editable: role === 'textbox', disabled: false, readOnly: false, visible: true, connected: true,
  }));
  const captures: ReturnType<typeof handles>[] = [];
  function handles() {
    return elements.map(description => {
      const handle = { evaluate: vi.fn(async () => structuredClone(description)), dispose: vi.fn(async () => {}), asElement: () => handle };
      return handle;
    });
  }
  const rootDispose = vi.fn(async () => {});
  const page = {
    url: () => url,
    evaluate: vi.fn(async () => ({ title: 'Fixture', length: 10, text: 'Fixture text', headings: ['Title'] })),
    evaluateHandle: vi.fn(async () => {
      const captured = handles(); captures.push(captured);
      return { getProperties: async () => new Map(captured.map((element, index) => [String(index), element])), dispose: rootDispose };
    }),
  } as unknown as Page;
  return { page, elements, captures, rootDispose, navigate: (value: string) => { url = value; } };
}

describe('observed browser references', () => {
  it('keeps duplicate names and uses the same numbering for all element kinds', async () => {
    const f = fixture();
    const snapshot = await takeBrowserSnapshot(f.page);
    expect(snapshot.match(/Same label/g)).toHaveLength(2);
    expect(snapshot).toContain('[@e4] textbox');
    expect((await resolveBrowserReference(f.page, '@e3', 'click')).element).toBe(f.captures[0][2]);
    expect((await resolveBrowserReference(f.page, '@e4', 'type')).element).toBe(f.captures[0][3]);
    await invalidateBrowserSnapshot(f.page);
    for (const handle of f.captures[0]) expect(handle.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not reuse IDs after refresh or navigation, and disposes the previous handles', async () => {
    const f = fixture(); await takeBrowserSnapshot(f.page);
    expect(await takeBrowserSnapshot(f.page)).toContain('[@e5] link');
    await expect(resolveBrowserReference(f.page, '@e1', 'click')).rejects.toThrow('已失效');
    for (const handle of f.captures[0]) expect(handle.dispose).toHaveBeenCalledTimes(1);
    f.navigate('https://fixture.example/new');
    await expect(resolveBrowserReference(f.page, '@e5', 'click')).rejects.toThrow('已失效');
    await invalidateBrowserSnapshot(f.page);
  });

  it.each(['name', 'role', 'href', 'fieldName', 'formAction', 'formMethod'])('rejects a repurposed element when its %s changes', async property => {
    const f = fixture(); await takeBrowserSnapshot(f.page);
    (f.elements[0] as unknown as Record<string, unknown>)[property] = 'changed';
    await expect(resolveBrowserReference(f.page, '@e1', 'click')).rejects.toThrow('元素已变化');
    expect(f.captures[0][0].dispose).toHaveBeenCalledTimes(1);
  });

  it.each(['connected', 'visible'])('rejects a target that is no longer %s without resolving a different element', async property => {
    const f = fixture(); await takeBrowserSnapshot(f.page);
    (f.elements[1] as unknown as Record<string, unknown>)[property] = false;
    await expect(resolveBrowserReference(f.page, '@e2', 'click')).rejects.toThrow('元素已变化');
  });

  it.each([undefined, {}, 1, '@e0', '@e-1', '@e1anything', '1', '@e999999999999999999'])('rejects malformed or unobserved refs: %s', async ref => {
    const f = fixture(); await takeBrowserSnapshot(f.page);
    await expect(resolveBrowserReference(f.page, ref, 'click')).rejects.toThrow();
    await invalidateBrowserSnapshot(f.page);
  });

  it('refuses disabled controls and typing into non-editable elements', async () => {
    const f = fixture(); f.elements[1].disabled = true; await takeBrowserSnapshot(f.page);
    await expect(resolveBrowserReference(f.page, '@e2', 'click')).rejects.toThrow('不可用');
    await expect(resolveBrowserReference(f.page, '@e3', 'type')).rejects.toThrow('不是可编辑输入框');
    await invalidateBrowserSnapshot(f.page);
  });

  it('releases every captured handle if snapshot extraction fails halfway through', async () => {
    const f = fixture();
    const original = vi.mocked(f.page.evaluateHandle).getMockImplementation()!;
    vi.spyOn(f.page, 'evaluateHandle').mockImplementation(async (...args) => {
      const result = await original(...args);
      f.captures[0][1].evaluate.mockRejectedValueOnce(new Error('Navigation destroyed the document'));
      return result;
    });
    await expect(takeBrowserSnapshot(f.page)).rejects.toThrow('destroyed');
    for (const handle of f.captures[0]) expect(handle.dispose).toHaveBeenCalledTimes(1);
    expect(f.rootDispose).toHaveBeenCalledTimes(1);
    await expect(resolveBrowserReference(f.page, '@e1', 'click')).rejects.toThrow('已失效');
  });

  it('keeps references local to the page that produced them', async () => {
    const a = fixture(), b = fixture();
    await Promise.all([takeBrowserSnapshot(a.page), takeBrowserSnapshot(b.page)]);
    expect((await resolveBrowserReference(a.page, '@e2', 'click')).element).toBe(a.captures[0][1]);
    expect((await resolveBrowserReference(b.page, '@e2', 'click')).element).toBe(b.captures[0][1]);
    await invalidateBrowserSnapshot(a.page); await invalidateBrowserSnapshot(b.page);
  });
});
