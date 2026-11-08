import { useT } from "@kuutti/i18n/react";
import {
  type ModeratorRejectionReason,
  PHOTOS_FOR_COMPLETENESS,
  PhotoDecisionResponse,
} from "@kuutti/schema";
import { type FormEvent, useId, useState } from "react";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Label } from "../../components/ui/label.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { api } from "../../lib/api.ts";
import { Dialog } from "../../lib/dialog.tsx";
import { REJECTION_REASONS } from "../media/index.ts";
import { type Refusals, useSend } from "./use-send.ts";

// Taking down one approved photo (#477, ADR-006 §2): a person's rejection of
// a photo others already see, the decision route's take_down. It is not a
// sanction, and nothing is deleted. Its confirm step says the effect in words
// and asks for a reason chosen on purpose, nothing preset (#250): the one the
// owner is told. Beside each approved photo on a person's page, and beside the
// photo a card's report points at (#476), where the page updates from the
// answer. English only (TD-17); keyboard first.

const REFUSALS: Refusals = {
  codes: {
    photo_not_approved: "admin.takeDown.error.photo_not_approved",
    not_found: "admin.takeDown.error.not_found",
  },
  failed: "admin.takeDown.error.failed",
};

/** The button beside an approved photo, and its confirm step. */
export function TakeDown({
  photoId,
  describedBy,
  leavesTooFew,
  onOpen,
  onDone,
}: {
  photoId: string;
  /** The photo's own line, so that with several photos the buttons tell apart. */
  describedBy: string;
  /** Fewer approved photos than a complete profile needs would be left: the step says what follows. */
  leavesTooFew: boolean;
  /** The step opens: the line that said the last change is cleared, so the next one is heard. */
  onOpen: () => void;
  /** Taken down: the photo as the take-down left it. */
  onDone: (answer: PhotoDecisionResponse) => Promise<void>;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        className="self-start"
        aria-describedby={describedBy}
        onClick={() => {
          onOpen();
          setOpen(true);
        }}
      >
        {t("admin.takeDown.action")}
      </Button>
      {open && (
        <TakeDownStep
          photoId={photoId}
          leavesTooFew={leavesTooFew}
          onCancel={() => setOpen(false)}
          onDone={async (answer) => {
            setOpen(false);
            await onDone(answer);
          }}
        />
      )}
    </>
  );
}

function TakeDownStep({
  photoId,
  leavesTooFew,
  onCancel,
  onDone,
}: {
  photoId: string;
  leavesTooFew: boolean;
  onCancel: () => void;
  onDone: (answer: PhotoDecisionResponse) => Promise<void>;
}) {
  const { t } = useT();
  const ids = useId();
  const [reason, setReason] = useState<ModeratorRejectionReason | "">("");
  // A 403 is the shell's to say (#302): the step closes with no words of its own.
  const { sending, refused, send } = useSend({
    answer: PhotoDecisionResponse,
    refusals: REFUSALS,
    onShell: onCancel,
    onDone,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (reason === "") return;
    void send(() =>
      api.POST("/admin/photos/{id}/decision", {
        params: { path: { id: photoId } },
        body: { decision: "take_down", reason },
      }),
    );
  };

  return (
    <Dialog title={t("admin.takeDown.title")} onClose={onCancel}>
      <form className="grid gap-4" onSubmit={submit}>
        <p>{t("admin.takeDown.effect")}</p>
        {leavesTooFew && (
          <p className="font-medium">
            {t("admin.takeDown.tooFew", { photos: PHOTOS_FOR_COMPLETENESS })}
          </p>
        )}
        {refused && <Alert>{t(refused)}</Alert>}
        <div className="grid gap-2">
          <Label htmlFor={`${ids}-reason`}>{t("admin.queue.reason.label")}</Label>
          <NativeSelect
            id={`${ids}-reason`}
            required
            value={reason}
            onChange={(event) => setReason(event.target.value as ModeratorRejectionReason)}
          >
            <option value="" disabled>
              {t("admin.queue.reason.choose")}
            </option>
            {REJECTION_REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {t(r.label)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            variant="destructive"
            disabled={reason === ""}
            aria-busy={sending || undefined}
          >
            {t("admin.takeDown.confirm")}
          </Button>
          <Button variant="outline" onClick={onCancel}>
            {t("admin.queue.cancel")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
