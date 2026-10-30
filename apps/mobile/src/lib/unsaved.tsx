import { createContext, type ReactNode, useContext, useEffect } from "react";

/** Says that a field under a row holds something not saved, or no longer. */
type Report = (row: string, field: string, unsaved: boolean) => void;

const RowContext = createContext<{ row: string; report: Report } | null>(null);

/**
 * The row of Settings a panel sits in (#511), so that a field in it can say
 * it holds what was not saved: a contact refused or not sent, an address
 * typed and not sent, feedback not sent. Settings marks the row, and asks
 * before it is left. Outside Settings (the e-mail among the later screens)
 * there is no row, and a field's word goes nowhere.
 */
export function UnsavedRow({
  row,
  report,
  children,
}: {
  row: string;
  report: Report;
  children: ReactNode;
}) {
  return <RowContext.Provider value={{ row, report }}>{children}</RowContext.Provider>;
}

/** Tells the row this field sits in whether it holds something not saved; and that it does not, as it goes. */
export function useReportUnsaved(field: string, unsaved: boolean) {
  const context = useContext(RowContext);
  const row = context?.row;
  const report = context?.report;
  useEffect(() => {
    if (row !== undefined) report?.(row, field, unsaved);
  }, [row, report, field, unsaved]);
  useEffect(
    () => () => {
      if (row !== undefined) report?.(row, field, false);
    },
    [row, report, field],
  );
}
