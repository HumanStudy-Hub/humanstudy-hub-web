"use client";

export default function ValidatedFilter({ checked }: { checked: boolean }) {
  return (
    <label>
      <input
        key={String(checked)}
        type="checkbox"
        name="validated"
        value="1"
        defaultChecked={checked}
        form="study-search"
        onChange={event => event.currentTarget.form?.requestSubmit()}
      />
      Validated protocols only
    </label>
  );
}
