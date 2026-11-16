import { test } from 'node:test';
import assert from 'node:assert/strict';
import { widgetRoute } from '../desktop/widget-link.mjs';

test('widget links resolve only a supported source or public channel', () => {
  const id = 'UC' + 'a'.repeat(22);
  assert.equal(widgetRoute('arguspip://open'), '');
  assert.equal(widgetRoute('arguspip://sales'), '#apple/7');
  assert.equal(widgetRoute('arguspip://youtube/'), '#youtube');
  assert.equal(widgetRoute('arguspip://youtube/' + id), '#youtube/' + id);
  for (const url of ['https://example.org', 'arguspip://sales/other', 'arguspip://youtube/?x=1', 'arguspip://youtube/%2F', 'arguspip://user@youtube']) {
    assert.equal(widgetRoute(url), null);
  }
});
