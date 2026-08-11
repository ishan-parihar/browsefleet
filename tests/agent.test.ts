import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runAgent, type AgentEvent } from '../src/agent/agent.js';

function fakePage() {
  return {
    screenshot: vi.fn().mockResolvedValue('aGVsbG8='),
    goto: vi.fn().mockResolvedValue(undefined),
    mouse: { click: vi.fn().mockResolvedValue(undefined), wheel: vi.fn().mockResolvedValue(undefined) },
    keyboard: { type: vi.fn().mockResolvedValue(undefined), press: vi.fn().mockResolvedValue(undefined) },
  };
}

// Mimics an Anthropic `/v1/messages` response: `json()` resolves to the
// parsed body the caller actually reads (`data.content[0].text`).
function llmResponse(text: string, ok = true, status = 200) {
  return {
    ok,
    status,
    text: vi.fn().mockResolvedValue(text),
    json: vi.fn().mockResolvedValue({ content: [{ text }] }),
  } as any;
}

const ANTHROPIC_JSON = JSON.stringify({
  actions: [{ type: 'done', result: 'task complete' }],
  reasoning: 'finished',
});

describe('runAgent', () => {
  let page: ReturnType<typeof fakePage>;
  let events: AgentEvent[];

  beforeEach(() => {
    page = fakePage();
    events = [];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(llmResponse(ANTHROPIC_JSON)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns success when the LLM responds with done', async () => {
    const result = await runAgent(page as any, { task: 'do a thing', apiKey: 'test-key' });
    expect(result.success).toBe(true);
    expect(result.result).toBe('task complete');
    expect(result.totalIterations).toBe(1);
    expect(page.screenshot).toHaveBeenCalled();
  });

  it('returns failure when no API key is configured', async () => {
    const result = await runAgent(page as any, { task: 'do a thing' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No API key/);
    expect(result.totalIterations).toBe(0);
  });

  it('emits screenshot, step, and done events via onEvent', async () => {
    const result = await runAgent(page as any, { task: 'do a thing', apiKey: 'k' }, (e) =>
      events.push(e),
    );
    expect(result.success).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['screenshot', 'step', 'done']);
  });

  it('executes non-terminal actions between iterations', async () => {
    const first = JSON.stringify({
      actions: [{ type: 'click', x: 10, y: 20 }],
      reasoning: 'clicking',
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(llmResponse(first))
        .mockResolvedValueOnce(llmResponse(ANTHROPIC_JSON)),
    );
    const result = await runAgent(page as any, { task: 'click and finish', apiKey: 'k' });
    expect(result.success).toBe(true);
    expect(page.mouse.click).toHaveBeenCalledWith(10, 20);
    expect(result.totalIterations).toBe(2);
  });

  it('fails cleanly when the LLM returns a fail action', async () => {
    const failJson = JSON.stringify({
      actions: [{ type: 'fail', reason: 'CAPTCHA detected' }],
      reasoning: 'cannot proceed',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(llmResponse(failJson)));
    const result = await runAgent(page as any, { task: 'x', apiKey: 'k' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('CAPTCHA detected');
  });

  it('stops at maxIterations without completing', async () => {
    const keepGoing = JSON.stringify({ actions: [{ type: 'wait', duration: 1 }], reasoning: 'still going' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(llmResponse(keepGoing)));
    const result = await runAgent(page as any, { task: 'loop forever', apiKey: 'k', maxIterations: 3 });
    expect(result.success).toBe(false);
    expect(result.totalIterations).toBe(3);
    expect(result.error).toMatch(/maximum iterations/);
  });

  it('returns failure when the LLM API errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('upstream down')));
    const result = await runAgent(page as any, { task: 'x', apiKey: 'k' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('upstream down');
  });
});
