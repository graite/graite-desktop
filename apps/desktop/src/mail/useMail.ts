import { useCallback, useEffect, useRef, useState } from "react";
import { onDaemonEvent } from "@/lib/api";
import { DRAFTS, mail, type MailAccount, type MailFolder } from "@/lib/mail";
import { scopedKey } from "@/lib/storage";

const ACCOUNT_KEY = "graite.mail.account";

/**
 * What is chosen in Mail: the account, the folder, the search and the open conversation.
 * Held by the workspace, because the sidebar (accounts and folders) and the Mail tab (list
 * and reader) both show it, and neither is always on screen.
 */
export function useMail() {
  const [accounts, setAccounts] = useState<MailAccount[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [accountId, setAccountId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(scopedKey(ACCOUNT_KEY));
    } catch {
      return null;
    }
  });
  const [folders, setFolders] = useState<MailFolder[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  // The draft being written, if any.
  const [draftId, setDraftId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Goes up when the chosen account's mail changed, so lists fetch again.
  const [version, setVersion] = useState(0);

  const account = accounts?.find((a) => a.id === accountId) ?? accounts?.[0] ?? null;
  const current = account?.id ?? null;
  const inbox = folders.find((f) => f.role === "inbox")?.name ?? folders[0]?.name ?? null;
  const shownFolder = folder ?? inbox;
  const showsDrafts = folder === DRAFTS;

  // The account on screen, also when none was ever chosen and the first one is shown.
  const shown = useRef(current);
  shown.current = current;

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts((await mail.accounts()).accounts);
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => void loadAccounts(), [loadAccounts]);

  useEffect(() => {
    if (!current) {
      setFolders([]);
      return;
    }
    let live = true;
    mail
      .folders(current)
      .then((found) => live && setFolders(found.folders))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [current, version]);

  useEffect(
    () =>
      onDaemonEvent((e) => {
        if (e.type !== "mail_changed") return;
        void loadAccounts();
        if ((e.data as { account_id?: string }).account_id === current) setVersion((v) => v + 1);
      }),
    [current, loadAccounts],
  );

  const choose = useCallback((id: string | null, folderName: string | null = null) => {
    try {
      if (id) localStorage.setItem(scopedKey(ACCOUNT_KEY), id);
      else localStorage.removeItem(scopedKey(ACCOUNT_KEY));
    } catch {
      /* storage unavailable: the choice lasts until the app closes */
    }
    // Another account: its folders are not known yet. The same one keeps what it has.
    if (id !== shown.current) setFolders([]);
    setAccountId(id);
    setFolder(folderName);
    setSearch("");
    setOpenId(null);
    setDraftId(null);
  }, []);

  return {
    accounts,
    loadError,
    loadAccounts,
    account,
    current,
    folders,
    shownFolder,
    showsDrafts,
    choose,
    search,
    setSearch,
    openId,
    setOpenId,
    draftId,
    setDraftId,
    bump: () => setVersion((v) => v + 1),
    adding,
    setAdding,
    version,
  };
}

export type MailState = ReturnType<typeof useMail>;
