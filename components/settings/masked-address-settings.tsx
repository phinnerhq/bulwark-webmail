'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy, Loader2, Pencil, Plus, Send, Trash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SettingsSection, ToggleSwitch } from './settings-section';
import { useConfirmDialog } from '@/hooks/use-confirm-dialog';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore, createIdentityWithHooks } from '@/stores/identity-store';
import { toast } from '@/stores/toast-store';
import { cn } from '@/lib/utils';
import {
  MaskedAddressRequestError,
  createMaskedAddress,
  deleteMaskedAddress,
  listMaskedAddresses,
  updateMaskedAddress,
  type MaskedAddress,
} from '@/lib/masked-addresses/client';

/** Error codes the route answers with that have their own message. */
const KNOWN_ERRORS = new Set(['limit_reached', 'session_expired', 'account_not_found', 'no_free_address']);

export function MaskedAddressSettings() {
  const t = useTranslations('settings.masked_addresses');
  const client = useAuthStore((s) => s.client);
  const identities = useIdentityStore((s) => s.identities);
  const { dialogProps, confirm } = useConfirmDialog();

  const [masks, setMasks] = useState<MaskedAddress[] | null>(null);
  const [domain, setDomain] = useState('');
  const [limit, setLimit] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ email: string; label: string } | null>(null);

  const errorMessage = useCallback((error: unknown) => {
    const code = error instanceof MaskedAddressRequestError ? error.code : '';
    return KNOWN_ERRORS.has(code) ? t(`errors.${code}`, { limit }) : t('errors.generic');
  }, [t, limit]);

  const load = useCallback(async () => {
    try {
      const list = await listMaskedAddresses();
      setMasks(list.masks);
      setDomain(list.domain);
      setLimit(list.limit);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const copy = useCallback(async (email: string) => {
    try {
      await navigator.clipboard.writeText(email);
      setCopied(email);
      setTimeout(() => setCopied((current) => (current === email ? null : current)), 1500);
    } catch {
      toast.error(t('copy_failed'));
    }
  }, [t]);

  const create = async () => {
    setCreating(true);
    try {
      const mask = await createMaskedAddress(label);
      setMasks((current) => [mask, ...(current ?? [])]);
      setFresh(mask.email);
      setLabel('');
      await copy(mask.email);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setCreating(false);
    }
  };

  const change = async (mask: MaskedAddress, changes: { enabled?: boolean; label?: string }) => {
    setBusy(mask.email);
    try {
      const updated = await updateMaskedAddress(mask.email, changes);
      setMasks((current) => current?.map((m) => (m.email === updated.email ? updated : m)) ?? null);
      return true;
    } catch (error) {
      toast.error(errorMessage(error));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const remove = async (mask: MaskedAddress) => {
    const ok = await confirm({
      title: t('delete_title'),
      message: t('delete_message', { email: mask.email }),
      confirmText: t('delete'),
      variant: 'destructive',
    });
    if (!ok) return;
    setBusy(mask.email);
    try {
      await deleteMaskedAddress(mask.email);
      setMasks((current) => current?.filter((m) => m.email !== mask.email) ?? null);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  /** A sending identity for the mask, without a name, so replies give nothing away. */
  const sendFrom = async (mask: MaskedAddress) => {
    if (!client) return;
    setBusy(mask.email);
    try {
      if (await createIdentityWithHooks(client, { name: '', email: mask.email })) {
        await useAuthStore.getState().refreshIdentities();
        toast.success(t('identity_created', { email: mask.email }));
      }
    } catch (error) {
      toast.error(t('identity_failed', { error: error instanceof Error ? error.message : '' }));
    } finally {
      setBusy(null);
    }
  };

  const hasIdentity = (email: string) => identities.some((identity) => identity.email.toLowerCase() === email);

  return (
    <SettingsSection title={t('title')} description={domain ? t('description', { domain }) : t('description_generic')}>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <Input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={t('label_placeholder')}
          aria-label={t('label_aria')}
          maxLength={100}
          disabled={creating || masks === null}
          data-testid="masked-address-label"
        />
        <Button type="submit" disabled={creating || masks === null} className="shrink-0 gap-1.5" data-testid="masked-address-create">
          {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          {t('create')}
        </Button>
      </form>

      {loadFailed ? (
        <div className="text-sm text-muted-foreground flex items-center gap-2">
          {t('load_failed')}
          <Button variant="outline" size="sm" onClick={() => void load()}>{t('retry')}</Button>
        </div>
      ) : masks === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="w-4 h-4 animate-spin" /> {t('loading')}
        </div>
      ) : masks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t('count', { count: masks.length, limit })}</p>
          <ul className="space-y-2" data-testid="masked-address-list">
            {masks.map((mask) => (
              <li
                key={mask.email}
                data-testid="masked-address"
                className={cn(
                  'flex flex-col gap-2 rounded-md bg-muted/50 px-3 py-2 sm:flex-row sm:items-center',
                  fresh === mask.email && 'ring-1 ring-primary',
                  !mask.enabled && 'opacity-70',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={cn('font-mono text-sm truncate', !mask.enabled && 'line-through')}>{mask.email}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 shrink-0"
                      onClick={() => void copy(mask.email)}
                      aria-label={t('copy', { email: mask.email })}
                      title={t('copy', { email: mask.email })}
                    >
                      {copied === mask.email ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    </Button>
                  </div>
                  {editing?.email === mask.email ? (
                    <form
                      className="mt-1 flex gap-2"
                      onSubmit={async (event) => {
                        event.preventDefault();
                        if (await change(mask, { label: editing.label })) setEditing(null);
                      }}
                    >
                      <Input
                        autoFocus
                        className="h-8"
                        value={editing.label}
                        maxLength={100}
                        aria-label={t('label_aria')}
                        onChange={(event) => setEditing({ email: mask.email, label: event.target.value })}
                        onKeyDown={(event) => { if (event.key === 'Escape') setEditing(null); }}
                      />
                      <Button type="submit" size="sm" disabled={busy === mask.email}>{t('save')}</Button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => setEditing({ email: mask.email, label: mask.label ?? '' })}
                    >
                      {mask.label || t('no_label')}
                      <Pencil className="w-3 h-3" aria-hidden="true" />
                      <span className="sr-only">{t('edit_label')}</span>
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {!hasIdentity(mask.email) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void sendFrom(mask)}
                      disabled={busy === mask.email || !mask.enabled}
                      title={t('send_from_hint')}
                      className="gap-1.5"
                    >
                      <Send className="w-3.5 h-3.5" />
                      {t('send_from')}
                    </Button>
                  )}
                  <ToggleSwitch
                    checked={mask.enabled}
                    onChange={(enabled) => void change(mask, { enabled })}
                    disabled={busy === mask.email}
                    ariaLabel={t(mask.enabled ? 'disable' : 'enable', { email: mask.email })}
                    testId="masked-address-toggle"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void remove(mask)}
                    disabled={busy === mask.email}
                    className="text-destructive hover:text-destructive"
                    aria-label={t('delete_aria', { email: mask.email })}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="text-xs text-muted-foreground">{t('footnote')}</p>
      <ConfirmDialog {...dialogProps} />
    </SettingsSection>
  );
}
