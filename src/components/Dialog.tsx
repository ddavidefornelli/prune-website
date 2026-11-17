import {
  createEffect,
  on,
  onCleanup,
  onMount,
  splitProps,
  type JSX,
} from "solid-js";

interface DialogProps extends JSX.DialogHtmlAttributes<HTMLDialogElement> {
  onDismiss: () => void;
  initialFocus?: (dialog: HTMLDialogElement) => void;
  preventCancel?: boolean;
  /**
   * False shows it without modality, so the page behind can be used; the
   * dialog's own content then decides what it covers. Defaults to true.
   */
  modal?: boolean;
}

/** Native modality and focus restoration, owned by the component lifecycle. */
export function Dialog(props: DialogProps) {
  const [local, attributes] = splitProps(props, [
    "children",
    "onDismiss",
    "initialFocus",
    "preventCancel",
    "modal",
  ]);
  let dialog!: HTMLDialogElement;

  onMount(() => {
    const opener = document.activeElement;
    if (local.modal === false) dialog.show();
    else dialog.showModal();
    local.initialFocus?.(dialog);
    onCleanup(() => {
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    });
  });

  createEffect(
    on(
      () => local.modal !== false,
      (modal) => {
        if (!dialog.open || dialog.matches(":modal") === modal) return;
        dialog.close();
        if (modal) dialog.showModal();
        else dialog.show();
      },
      { defer: true },
    ),
  );

  return (
    <dialog
      {...attributes}
      ref={(element) => (dialog = element)}
      onCancel={(event) => {
        event.preventDefault();
        if (!local.preventCancel) local.onDismiss();
      }}
    >
      {local.children}
    </dialog>
  );
}
