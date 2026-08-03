"use client";
import { useEffect } from "react";

/**
 * Ninety-style create modal: dim overlay, orange top rule, "Create <accent>"
 * header with a close button, a scrollable body, and a Create/Cancel footer.
 */
export default function Modal({ open, onClose, prefix = "Create", accent, onSubmit, submitLabel, submitDisabled, children }) {
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal-panel" onMouseDown={(e) => e.stopPropagation()}>
        <form onSubmit={onSubmit}>
          <div className="modal-head">
            <h2 className="modal-title">{prefix} <span className="modal-accent">{accent}</span></h2>
            <button type="button" className="modal-x" onClick={onClose} aria-label="Close">✕</button>
          </div>

          <div className="modal-body">{children}</div>

          <div className="modal-footer">
            <button className="btn-secondary" type="submit" disabled={submitDisabled}>{submitLabel || `${prefix} ${accent}`}</button>
            <button className="btn-ghost" type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
