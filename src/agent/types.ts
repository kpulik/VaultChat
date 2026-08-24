/**
 * How risky a tool is, which decides whether it runs on its own (§25).
 *
 *  read        - searching, reading, listing. Runs without asking.
 *  write       - a single create, edit, rename, move or copy. Reviewable.
 *  destructive - deletion, or any batch. Always requires explicit confirmation.
 */
export type ToolRisk = 'read' | 'write' | 'destructive';

export interface ToolCall {
  /** Stable per call, so a result can be matched back to its request. */
  id:   string;
  tool: string;
  args: Record<string, unknown>;
  /** The block this came from, kept for error reporting. */
  raw:  string;
}

/**
 * Why a tool call failed.
 *
 * §44 requires these to stay distinguishable: "not found" and "ambiguous" call
 * for completely different responses from the model, and collapsing them into
 * one error string is how an agent ends up guessing.
 */
export type ToolErrorKind =
  | 'unknown_tool'
  | 'invalid_args'
  | 'not_found'
  | 'ambiguous'
  | 'protected'
  | 'failed';

export interface ToolError {
  kind:    ToolErrorKind;
  message: string;
  /** Populated for `ambiguous`, so the model can ask the user to choose. */
  candidates?: { path: string; reason: string }[];
}

export type ToolResult =
  | { ok: true;  id: string; tool: string; data: unknown }
  | { ok: false; id: string; tool: string; error: ToolError };

export interface ToolParam {
  name:     string;
  type:     'string' | 'string[]' | 'boolean' | 'number';
  required: boolean;
  /** Validated with isSafeVaultPath before the tool ever runs. */
  isPath?:  boolean;
  desc:     string;
}

export interface ToolDef {
  name:   string;
  risk:   ToolRisk;
  desc:   string;
  params: ToolParam[];
}
