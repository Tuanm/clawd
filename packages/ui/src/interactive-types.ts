// Shared types and lenient JSON parser for interactive artifacts.

export interface InteractiveSpec {
  title?: string;
  one_shot?: boolean;
  components: ComponentSpec[];
}

export interface ComponentSpec {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface InteractiveState {
  values: Record<string, unknown>;
  submitted: boolean;
  submitting: boolean;
  error: string | null;
  selectedAction: string | null;
  selectedComponentId: string | null;
  selectedValue: unknown;
}

export type InteractiveAction =
  | { type: "SET_VALUE"; id: string; value: unknown }
  | { type: "SUBMIT_START" }
  | {
      type: "SUBMIT_SUCCESS";
      selectedLabel?: string | null;
      selectedComponentId?: string | null;
      selectedValue?: unknown;
    }
  | { type: "SUBMIT_RESET" }
  | { type: "SUBMIT_ERROR"; error: string }
  | { type: "SET_SUBMITTED" };

/** Lenient JSON parser — handles common LLM failures (fences, trailing commas, comments) */
export function parseInteractiveJson(raw: string): InteractiveSpec | null {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/m, "$1")
    .trim();
  try {
    return JSON.parse(stripped) as InteractiveSpec;
  } catch {}
  const cleaned = stripped
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  try {
    return JSON.parse(cleaned) as InteractiveSpec;
  } catch {}
  return null;
}

/** Build initial form values from component defaults */
export function buildInitialValues(spec: InteractiveSpec): Record<string, unknown> {
  const vals: Record<string, unknown> = {};
  for (const c of spec.components) {
    if (c.id) {
      const def = (c as Record<string, unknown>).default;
      vals[c.id as string] = c.type === "checkbox" ? def === true : (def ?? "");
    }
  }
  return vals;
}

export function interactiveReducer(state: InteractiveState, action: InteractiveAction): InteractiveState {
  switch (action.type) {
    case "SET_VALUE":
      return { ...state, values: { ...state.values, [action.id]: action.value } };
    case "SUBMIT_START":
      return { ...state, submitting: true, error: null };
    case "SUBMIT_SUCCESS":
      return {
        ...state,
        submitting: false,
        submitted: true,
        selectedAction: action.selectedLabel ?? null,
        selectedComponentId: action.selectedComponentId ?? null,
        selectedValue: action.selectedValue ?? null,
      };
    case "SUBMIT_RESET":
      return { ...state, submitting: false };
    case "SUBMIT_ERROR":
      return { ...state, submitting: false, error: action.error };
    case "SET_SUBMITTED":
      return { ...state, submitted: true };
    default:
      return state;
  }
}
