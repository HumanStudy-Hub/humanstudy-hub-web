"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/app/build-preview/ui";
import s from "@/app/build-preview/workspace.module.css";

export type WorkspaceCommand = { id: string; label: string; shortcut?: string; disabled?: boolean; run: () => void };

export default function WorkspaceCommands({ commands, onClose }: { commands: WorkspaceCommand[]; onClose: () => void }) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const matches = commands.filter(command => t(command.label).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const current = Math.min(selected, Math.max(0, matches.length - 1));

  useEffect(() => { dialog.current?.showModal(); input.current?.focus(); }, []);
  useEffect(() => { dialog.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [current, query]);
  function execute(command: WorkspaceCommand) {
    if (command.disabled) return;
    onClose();
    command.run();
  }

  return <dialog ref={dialog} className={s.commandPalette} aria-label={t("Workspace commands")} onClose={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); return; }
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSelected(matches.length ? (current + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length : 0);
    } else if (event.key === "Enter") { event.preventDefault(); if (matches[current]) execute(matches[current]); }
  }}>
    <div className={s.commandSearch}><span aria-hidden="true">&gt;</span><input ref={input} aria-label={t("Search commands")} placeholder={t("Search commands…")} value={query} onChange={event => { setQuery(event.target.value); setSelected(0); }} role="combobox" aria-expanded="true" aria-controls="workspace-command-list" aria-activedescendant={matches[current] ? `workspace-command-${matches[current].id}` : undefined}/><button type="button" aria-label={t("Close")} onClick={onClose}>×</button></div>
    <div id="workspace-command-list" role="listbox" aria-label={t("Workspace commands")} className={s.commandList}>{matches.map((command, index) => <button type="button" id={`workspace-command-${command.id}`} key={command.id} data-event={`workspace.command.${command.id}`} role="option" aria-selected={index === current} disabled={command.disabled} onFocus={() => setSelected(index)} onPointerMove={() => setSelected(index)} onClick={() => execute(command)}><span>{t(command.label)}</span>{command.shortcut && <kbd>{command.shortcut}</kbd>}</button>)}{!matches.length && <p>{t("No matching commands")}</p>}</div>
    <footer><span>↑ ↓ {t("Navigate")}</span><span>↵ {t("Choose")}</span><span>Esc {t("Close")}</span></footer>
  </dialog>;
}
