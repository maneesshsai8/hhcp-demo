/**
 * Built-in meeting agenda templates (EOS). Faithful port of
 * backend/app/agendas.py. Each section's `kind` tells the frontend runner what
 * to show: segue | scorecard | rocks | todos | issues | vcbs | text | conclude.
 */
export interface AgendaSection {
  key: string;
  label: string;
  minutes: number;
  kind: string;
  prompt: string;
}
export interface Agenda {
  key: string;
  name: string;
  type: string;
  sections: AgendaSection[];
}

export const AGENDAS: Record<string, Agenda> = {
  level10: {
    key: 'level10',
    name: 'Level 10 Meeting™',
    type: 'EOS',
    sections: [
      { key: 'segue', label: 'Segue', minutes: 5, kind: 'segue', prompt: 'Share your personal and professional best from the week.' },
      { key: 'scorecard', label: 'Scorecard', minutes: 5, kind: 'scorecard', prompt: 'Review the weekly numbers. On-track or off-track?' },
      { key: 'rock_review', label: 'Rock Review', minutes: 5, kind: 'rocks', prompt: 'Each Rock: on-track or off-track? Off-track Rocks become Issues.' },
      { key: 'vcb_review', label: 'VCB Review', minutes: 5, kind: 'vcbs', prompt: 'Value Creation Blueprints — progress toward the investment thesis.' },
      { key: 'headlines', label: 'Customer / Employee Headlines', minutes: 5, kind: 'text', prompt: 'Share customer and employee headlines — good and bad.' },
      { key: 'todos', label: 'To-Do List', minutes: 5, kind: 'todos', prompt: "Review last week's to-dos. Done or not done?" },
      { key: 'ids', label: 'IDS™', minutes: 60, kind: 'issues', prompt: 'Identify, Discuss, and Solve the most important issues.' },
      { key: 'conclude', label: 'Conclude', minutes: 5, kind: 'conclude', prompt: 'Recap new to-dos, cascading messages, and rate the meeting 1–10.' },
    ],
  },
  quarterly: {
    key: 'quarterly',
    name: 'Quarterly Session',
    type: 'EOS',
    sections: [
      { key: 'objectives', label: 'Objectives', minutes: 5, kind: 'text', prompt: "State the objectives for today's session." },
      { key: 'checkin', label: 'Check-in', minutes: 15, kind: 'segue', prompt: "Best personal / business news, what's working / not working." },
      { key: 'prior', label: 'Review Prior Quarter', minutes: 30, kind: 'scorecard', prompt: "Review last quarter's scorecard and results." },
      { key: 'rocks', label: 'Set Next-Quarter Rocks', minutes: 120, kind: 'rocks', prompt: 'Establish the Rocks for the coming quarter.' },
      { key: 'ids', label: 'IDS™', minutes: 60, kind: 'issues', prompt: "Identify, Discuss, Solve the quarter's issues." },
      { key: 'conclude', label: 'Conclude', minutes: 8, kind: 'conclude', prompt: 'Recap, cascading messages, rate the session.' },
    ],
  },
  weekly_1on1: {
    key: 'weekly_1on1',
    name: 'Weekly 1-on-1',
    type: 'EOS',
    sections: [
      { key: 'checkin', label: 'Check-in', minutes: 5, kind: 'segue', prompt: 'How are things going, personally and professionally?' },
      { key: 'rocks', label: 'Rocks', minutes: 10, kind: 'rocks', prompt: 'Progress on individual Rocks.' },
      { key: 'todos', label: 'To-Dos', minutes: 5, kind: 'todos', prompt: 'Review outstanding to-dos.' },
      { key: 'ids', label: 'Discuss & Solve', minutes: 10, kind: 'issues', prompt: 'Any issues to work through together.' },
    ],
  },
};

export function agenda(key: string): Agenda | undefined {
  return AGENDAS[key];
}

export function totalMinutes(a: Agenda): number {
  return a.sections.reduce((sum, s) => sum + s.minutes, 0);
}
