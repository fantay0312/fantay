import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';
import { extractPaDocument, renderPaPdfScan } from '../src/services/pa/channel-document-text.js';
import { attachPaFeishuCardFrames } from '../src/integrations/pa-feishu.js';
import { paAudioFormat } from '../src/services/personal-agent-voice.js';
import { parsePaChannelView, validatePaViewAnswer } from '../src/services/pa/channel-view.js';

async function archive(parts: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, xml] of Object.entries(parts)) zip.file(name, xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('channel documents', () => {
  it('extracts Word paragraphs and table content', async () => {
    const bytes = await archive({
      'word/document.xml': '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>发布计划 &amp; 预算</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格内容</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    });
    expect(await extractPaDocument('docx', bytes, new AbortController().signal)).toContain('发布计划 & 预算\n表格内容');
  });

  it('retains spreadsheet labels, shared text, inline strings and cached values', async () => {
    const bytes = await archive({
      'xl/workbook.xml': '<workbook xmlns:r="urn:r"><sheet name="预算" r:id="r1"/></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet7.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>标题</t></si></sst>',
      'xl/worksheets/sheet7.xml': '<worksheet><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>说明</t></is></c><c r="C1"><f>1+2</f><v>3</v></c></row></worksheet>',
    });
    expect(await extractPaDocument('xlsx', bytes, new AbortController().signal)).toBe('[预算]\nA1: 标题 | B1: 说明 | C1: 3');
  });

  it('reads slides in presentation order from the relationships', async () => {
    const bytes = await archive({
      'ppt/presentation.xml': '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldId r:id="r2"/><p:sldId r:id="r1"/></p:presentation>',
      'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="r1" Target="slides/slide1.xml"/><Relationship Id="r2" Target="slides/slide2.xml"/></Relationships>',
      'ppt/slides/slide1.xml': '<a:p xmlns:a="urn:a"><a:r><a:t>Second slide</a:t></a:r></a:p>',
      'ppt/slides/slide2.xml': '<a:p xmlns:a="urn:a"><a:r><a:t>First slide</a:t></a:r></a:p>',
    });
    expect(await extractPaDocument('pptx', bytes, new AbortController().signal)).toBe('[Slide 1]\nFirst slide\n\n[Slide 2]\nSecond slide');
  });

  it('extracts a born-digital PDF with its page number', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText('Fantay channel PDF excerpt', { font, x: 40, y: 600 });
    expect(await extractPaDocument('pdf', Buffer.from(await pdf.save()), new AbortController().signal)).toContain('[Page 1]\nFantay channel PDF excerpt');
  });

  it('renders a PDF without a text layer as bounded page images', async () => {
    const pdf = await PDFDocument.create();
    for (let page = 0; page < 3; page++) pdf.addPage().drawRectangle({ x: 20, y: 20, width: 50, height: 20 });
    const bytes = Buffer.from(await pdf.save());
    const signal = new AbortController().signal;
    expect(await extractPaDocument('pdf', bytes, signal)).toBe('');
    const pages = await renderPaPdfScan(bytes, 2, 1024 * 1024, signal);
    expect(pages).toHaveLength(2);
    expect(Buffer.from(pages[0]!.data, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('rejects external entities and oversized compressed Office parts', async () => {
    const signal = new AbortController().signal;
    const external = await archive({ 'word/document.xml': '<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]><x>&y;</x>' });
    await expect(extractPaDocument('docx', external, signal)).rejects.toThrow(/document type/i);
    const large = await archive({ 'word/document.xml': '<x>' + 'x'.repeat(8 * 1024 * 1024) + '</x>' });
    await expect(extractPaDocument('docx', large, signal)).rejects.toThrow(/exceeds/i);
  });
});

describe('channel audio and view formats', () => {
  it('detects native WeChat audio and common IM media containers', () => {
    expect(paAudioFormat(Buffer.from('\x02#!SILK_V3'))).toBe('silk');
    expect(paAudioFormat(Buffer.from('OggS'))).toBe('ogg');
    expect(paAudioFormat(Buffer.from('RIFF\0\0\0\0WAVE'))).toBe('wav');
    expect(paAudioFormat(Buffer.from('#EXTM3U\nhttp://127.0.0.1/'))).toBeNull();
  });

  it('validates forms and excludes executable views and credential prompts', () => {
    const form = { title: '需求', view: { type: 'form', id: 'details', fields: [{ id: 'audience', label: '读者' }] } };
    const card = parsePaChannelView(JSON.stringify({ channelView: form }))!;
    expect(card.interactive).toBe(true);
    expect(validatePaViewAnswer(card, 'details', { fields: { audience: 'New users' } })).toEqual({
      action: 'details', values: { fields: { audience: 'New users' } },
    });
    expect(() => validatePaViewAnswer(card, 'details', { fields: { invalid: 'Unknown field' } })).toThrow();
    expect(() => parsePaChannelView(JSON.stringify({ channelView: { view: { type: 'html', html: '<script>alert(1)</script>', summary: 'x' } } }))).toThrow();
    form.view.fields[0]!.label = '请输入 API 密钥';
    expect(() => parsePaChannelView(JSON.stringify({ channelView: form }))).toThrow();
  });

  it('routes a native Feishu card frame through the SDK dispatcher and acknowledges it', async () => {
    const ws = new WSClient({ appId: 'cli_test', appSecret: 'synthetic', loggerLevel: LoggerLevel.error });
    type Frame = { headers: Array<{ key: string; value: string }>; payload: Uint8Array };
    const socket = ws as unknown as { handleEventData(frame: Frame): Promise<void>; sendMessage(frame: Frame): void };
    const sent = vi.spyOn(socket, 'sendMessage').mockImplementation(() => {});
    const clicked = vi.fn();
    try {
      const dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.error }).register({ 'card.action.trigger': clicked });
      attachPaFeishuCardFrames(ws, dispatcher);
      const frame: Frame = {
        headers: [{ key: 'type', value: 'card' }, { key: 'message_id', value: 'fixture' }, { key: 'sum', value: '1' }, { key: 'seq', value: '0' }],
        payload: new TextEncoder().encode(JSON.stringify({
          schema: '2.0', header: { event_type: 'card.action.trigger', tenant_key: 'tenant' },
          event: { operator: { open_id: 'owner' }, context: { open_chat_id: 'talk', open_message_id: 'card' }, action: { value: { v: 'selected' } } },
        })),
      };
      await socket.handleEventData(frame);
      expect(clicked).toHaveBeenCalledOnce();
      expect(sent.mock.calls[0]?.[0].headers).toContainEqual({ key: 'type', value: 'card' });
      expect(JSON.parse(new TextDecoder().decode(sent.mock.calls[0]?.[0].payload))).toEqual({ code: 200 });
    } finally { ws.close({ force: true }); }
  });
});
