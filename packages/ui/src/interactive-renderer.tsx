// InteractiveRenderer — renders declarative interactive artifact JSON inline in messages.
// ALL components (button, button_group, text_input, select, checkbox, rating) update local state only.
// Only the "submit" component fires the action to the server and disables the artifact.
// If no "submit" exists, artifact stays interactive (e.g., chart filters, toggles).

import React, { useEffect, useReducer } from "react";
import { authFetch } from "./auth-fetch";
import {
  ButtonComponent,
  ButtonGroupComponent,
  CheckboxComponent,
  DividerComponent,
  RatingComponent,
  SelectComponent,
  SliderComponent,
  SubmitComponent,
  TextComponent,
  TextInputComponent,
} from "./interactive-components";
import {
  ChartEmbedComponent,
  DatePickerComponent,
  ImageComponent,
  NumberInputComponent,
  RadioGroupComponent,
  TableComponent,
  TabsComponent,
  ToggleComponent,
} from "./interactive-components-extended";
import { buildInitialValues, type ComponentSpec, interactiveReducer, parseInteractiveJson } from "./interactive-types";

interface InteractiveRendererProps {
  content: string;
  messagTs: string;
  channel: string;
  artifactIndex?: number;
  preSubmitted?: boolean;
  preAction?: { action_id: string; value: string; user: string } | null;
}

export default function InteractiveRenderer({
  content,
  messagTs,
  channel,
  artifactIndex = 0,
  preSubmitted = false,
  preAction = null,
}: InteractiveRendererProps) {
  const spec = React.useMemo(() => parseInteractiveJson(content), [content]);

  const preSelected = React.useMemo(() => {
    if (!preAction || !spec) return null;
    try {
      const parts = preAction.action_id.split(":");
      const componentId = parts.length > 1 ? parts.slice(1).join(":") : parts[0];
      const parsed = JSON.parse(preAction.value);
      const val = typeof parsed === "object" && parsed !== null ? (parsed[componentId] ?? parsed) : parsed;
      return { componentId, value: val };
    } catch {
      return null;
    }
  }, [preAction, spec]);

  const [state, dispatch] = useReducer(interactiveReducer, {
    values: spec ? buildInitialValues(spec) : {},
    submitted: preSubmitted,
    submitting: false,
    error: null,
    selectedAction: null,
    selectedComponentId: preSelected?.componentId ?? null,
    selectedValue: preSelected?.value ?? null,
  });

  useEffect(() => {
    if (preSubmitted && !state.submitted) dispatch({ type: "SET_SUBMITTED" });
  }, [preSubmitted, state.submitted]);

  if (!spec) {
    return (
      <div className="interactive-error-card">
        <p>Could not render interactive component</p>
        <details>
          <summary>Raw JSON</summary>
          <pre>{content}</pre>
        </details>
      </div>
    );
  }

  const isOneShot = spec.one_shot !== false;
  const isDisabled = (isOneShot && state.submitted) || state.submitting;

  // All components (including button/button_group) use this to update local state
  const handleChange = (id: string, value: unknown) => {
    if (isDisabled) return;
    dispatch({ type: "SET_VALUE", id, value });
  };

  // Only "submit" component calls this — fires to server
  const handleSubmit = async (componentId: string, value: unknown) => {
    if (isDisabled) return;
    dispatch({ type: "SUBMIT_START" });
    const actionId = `${artifactIndex}:${componentId}`;
    try {
      const res = await authFetch("/api/artifact.action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_ts: messagTs, channel, action_id: actionId, value, values: state.values }),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "Request failed");
        dispatch({ type: "SUBMIT_ERROR", error: err });
        return;
      }
      if (isOneShot) {
        dispatch({ type: "SUBMIT_SUCCESS", selectedComponentId: componentId, selectedValue: value });
      } else {
        dispatch({ type: "SUBMIT_RESET" });
      }
    } catch (e) {
      dispatch({ type: "SUBMIT_ERROR", error: e instanceof Error ? e.message : "Network error" });
    }
  };

  return (
    <div
      className={`interactive-area${isDisabled ? " interactive-area--disabled" : ""}${state.submitting ? " interactive-area--loading" : ""}`}
    >
      {state.error && (
        <div className="interactive-error-inline" role="alert">
          {state.error}
        </div>
      )}
      <div className="interactive-components-list">
        {spec.components.map((comp, i) => (
          <ComponentRenderer
            key={comp.id ?? i}
            spec={comp}
            disabled={isDisabled}
            value={state.values[String(comp.id ?? "")]}
            onChange={handleChange}
            onSubmit={handleSubmit}
            selectedComponentId={state.selectedComponentId}
            selectedValue={state.selectedValue}
          />
        ))}
      </div>
    </div>
  );
}

function ComponentRenderer({
  spec,
  disabled,
  value,
  onChange,
  onSubmit,
  selectedComponentId,
  selectedValue,
}: {
  spec: ComponentSpec;
  disabled: boolean;
  value: unknown;
  onChange: (id: string, value: unknown) => void;
  onSubmit: (id: string, value: unknown) => void;
  selectedComponentId: string | null;
  selectedValue: unknown;
}) {
  switch (spec.type) {
    case "text":
      return <TextComponent spec={spec} />;
    case "button":
      return (
        <ButtonComponent
          spec={spec}
          disabled={disabled}
          onAction={onChange}
          isSelected={String(spec.value ?? spec.id) === String(selectedValue)}
        />
      );
    case "button_group":
      return (
        <ButtonGroupComponent
          spec={spec}
          disabled={disabled}
          onAction={onChange}
          selectedValue={selectedComponentId === String(spec.id ?? "") ? selectedValue : (value ?? null)}
        />
      );
    case "text_input":
      return <TextInputComponent spec={spec} disabled={disabled} value={value} onChange={onChange} />;
    case "select":
      return <SelectComponent spec={spec} disabled={disabled} value={value} onChange={onChange} />;
    case "checkbox":
      return <CheckboxComponent spec={spec} disabled={disabled} value={value} onChange={onChange} />;
    case "rating":
      return <RatingComponent spec={spec} disabled={disabled} value={value} onChange={onChange} />;
    case "slider":
      return <SliderComponent spec={spec} disabled={disabled} value={value} onChange={onChange} />;
    case "submit":
      return <SubmitComponent spec={spec} disabled={disabled} onSubmit={onSubmit} />;
    case "divider":
      return <DividerComponent />;
    case "toggle":
      return <ToggleComponent spec={spec} disabled={disabled} value={value} onChange={onChange} />;
    case "radio_group":
      return <RadioGroupComponent spec={spec} disabled={disabled} value={value} onChange={onChange} />;
    case "number_input":
      return <NumberInputComponent spec={spec} disabled={disabled} value={value} onChange={onChange} />;
    case "date_picker":
      return <DatePickerComponent spec={spec} disabled={disabled} value={value} onChange={onChange} />;
    case "image":
      return <ImageComponent spec={spec} />;
    case "table":
      return <TableComponent spec={spec} />;
    case "tabs":
      return <TabsComponent spec={spec} disabled={disabled} value={value} onChange={onChange} />;
    case "chart":
      return <ChartEmbedComponent spec={spec} />;
    default:
      return null;
  }
}
