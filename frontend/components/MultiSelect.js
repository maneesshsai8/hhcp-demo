"use client";
import { useEffect, useRef, useState } from "react";

/**
 * A dropdown multi-select. Looks like a normal <select> trigger; clicking it
 * opens a panel of checkboxes. `options` = [{id, name}], `selected` = [id],
 * `onToggle(id)` flips one. Closes on outside-click.
 */
export default function MultiSelect({ options, selected, onToggle, placeholder = "Select…", empty = "No options." }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const chosen = options.filter((o) => selected.includes(o.id));

  return (
    <div className="ms" ref={ref}>
      <button type="button" className="ms-trigger" onClick={() => setOpen((o) => !o)}>
        <span className={chosen.length ? "" : "ms-ph"}>
          {chosen.length ? chosen.map((o) => o.name).join(", ") : placeholder}
        </span>
        <span className="ms-caret">▾</span>
      </button>
      {open && (
        <div className="ms-menu">
          {options.length === 0 && <p className="ms-empty">{empty}</p>}
          {options.map((o) => (
            <label key={o.id} className="ms-opt">
              <input type="checkbox" checked={selected.includes(o.id)} onChange={() => onToggle(o.id)} />
              {o.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
