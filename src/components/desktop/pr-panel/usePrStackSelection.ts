import { useState } from 'react';

/** Stack navigation keeps its read-only authority when a parent echoes selection. */
export function usePrStackSelection(repo: string, initialNumber: number, readOnly = false) {
  const owner = `${repo}:${initialNumber}`;
  const [selection, setSelection] = useState({ repo, owner, number: initialNumber, readOnly });
  const sameJourney = selection.repo === repo && (selection.owner === owner || `${repo}:${selection.number}` === owner);
  const number = selection.owner === owner ? selection.number : initialNumber;
  const selectedReadOnly = readOnly || sameJourney && selection.readOnly;
  if (selection.owner !== owner) setSelection({ repo, owner, number: initialNumber, readOnly: selectedReadOnly });
  return { number, readOnly: selectedReadOnly, select: (next: number) => setSelection({ repo, owner, number: next, readOnly: true }) };
}
