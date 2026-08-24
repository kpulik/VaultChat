// Why a request produced no visible answer.
//
// Pure, so every branch is testable. The old behaviour said "that model or
// route is not answering, so try a different one" for every empty run, which is
// actively misleading when the real cause was a token limit the user set, a
// content filter, or a reasoning model whose entire output was chain of thought.

import type { StreamSummary } from './stream';

export type EmptyDiagnosis =
  | { kind: 'stopped';        message: string }
  /** The model produced only chain of thought. That text is the whole output. */
  | { kind: 'reasoning-only'; message: string; reasoning: string }
  | { kind: 'explained';      message: string };

export function diagnoseEmptyResponse(
  model: string,
  summary: StreamSummary,
  stoppedByUser: boolean,
): EmptyDiagnosis {
  if (stoppedByUser) {
    return { kind: 'stopped', message: 'Stopped before the model replied.' };
  }

  const reasoning = summary.reasoningText.trim();
  if (reasoning !== '') {
    return {
      kind: 'reasoning-only',
      message: `${model} returned only reasoning and no answer. Its thinking is shown below.`,
      reasoning,
    };
  }

  if (summary.finishReason === 'length' || summary.finishReason === 'max_tokens') {
    return {
      kind: 'explained',
      message: `${model} hit the output token limit before writing anything. `
             + 'Raise Max tokens in settings, or send less context.',
    };
  }

  if (summary.finishReason === 'content_filter') {
    return {
      kind: 'explained',
      message: `${model} refused the request through a content filter.`,
    };
  }

  if (summary.finishReason) {
    return {
      kind: 'explained',
      message: `${model} returned no content and stopped with "${summary.finishReason}".`,
    };
  }

  return {
    kind: 'explained',
    message: `${model} returned an empty response with no reason given. `
           + 'That route is most likely dead upstream, so try a different model or endpoint.',
  };
}
