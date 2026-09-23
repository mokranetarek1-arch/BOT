import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { crmFieldService, type CustomFieldInput } from '@/services/crmFieldService';
import { organizationService } from '@/services/organizationService';
import type { CrmCustomField, CustomFieldType } from '@/types';

/**
 * AI Configuration — the CRM field builder.
 *
 * This is the only place where the CRM schema is defined: every field listed
 * here (crm_custom_fields) becomes a column of the CRM tables and a target of
 * the AI extraction. The AI never invents fields — it only fills these.
 */

const FIELD_TYPES: { value: CustomFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'select', label: 'Select (fixed choices)' },
  { value: 'phone', label: 'Phone' },
  { value: 'date', label: 'Date' },
];

const FIELD_NAME_RE = /^[a-z0-9_]+$/;

const EMPTY_DRAFT = {
  field_name: '',
  field_label: '',
  field_type: 'text' as CustomFieldType,
  options_text: '',
  description_for_ai: '',
};

export default function AISettings() {
  const [orgId, setOrgId] = useState<string | null>(null);
  const [fields, setFields] = useState<CrmCustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Organization + the organization's CRM fields (initial load only).
  useEffect(() => {
    let cancelled = false;
    organizationService
      .getCurrentOrganizationId()
      .then(async (resolvedOrgId) => {
        if (cancelled) return;
        setOrgId(resolvedOrgId);
        const list = await crmFieldService.listCustomFields(resolvedOrgId);
        if (!cancelled) setFields(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load CRM settings.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const startEdit = (field: CrmCustomField) => {
    setEditingId(field.id);
    setDraft({
      field_name: field.field_name,
      field_label: field.field_label,
      field_type: field.field_type,
      options_text: (field.options ?? []).join(', '),
      description_for_ai: field.description_for_ai ?? '',
    });
  };

  const resetDraft = () => {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
  };

  const saveDraft = async () => {
    if (!orgId || saving) return;
    setError(null);
    setNotice(null);

    const fieldName = draft.field_name.trim().toLowerCase();
    if (!FIELD_NAME_RE.test(fieldName)) {
      setError('Field name must be lowercase letters, digits and underscores only.');
      return;
    }
    if (!draft.field_label.trim()) {
      setError('Field label is required.');
      return;
    }

    try {
      const input: CustomFieldInput = {
        field_name: fieldName,
        field_label: draft.field_label.trim(),
        field_type: draft.field_type,
        description_for_ai: draft.description_for_ai.trim() || null,
        options: draft.options_text
          ? draft.options_text.split(',').map((opt) => opt.trim()).filter(Boolean)
          : null,
      };
      setSaving(true);
      if (editingId) {
        await crmFieldService.updateCustomField(editingId, input);
        setFields((prev) =>
          prev.map((field) =>
            field.id === editingId
              ? {
                  ...field,
                  field_name: input.field_name,
                  field_label: input.field_label,
                  field_type: input.field_type,
                  options: input.field_type === 'select' ? input.options ?? [] : null,
                  description_for_ai: input.description_for_ai ?? null,
                }
              : field,
          ),
        );
        setNotice('Field updated.');
      } else {
        const created = await crmFieldService.createCustomField(orgId, input);
        setFields((prev) => [...prev, created]);
        setNotice(`Field "${created.field_label}" added.`);
      }
      resetDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the field.');
    } finally {
      setSaving(false);
    }
  };

  const removeField = async (field: CrmCustomField) => {
    if (saving) return;
    setError(null);
    setNotice(null);
    try {
      setSaving(true);
      await crmFieldService.deleteCustomField(field.id);
      setFields((prev) => prev.filter((item) => item.id !== field.id));
      if (editingId === field.id) resetDraft();
      setNotice(`Field "${field.field_label}" deleted.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the field.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-bold mb-6">AI Configuration</h1>

      
      <div className="space-y-6">
      {error && <p className="text-sm text-destructive mb-4">{error}</p>}
      {notice && <p className="text-sm text-green-600 mb-4">{notice}</p>}

      {loading && <p className="text-sm text-muted-foreground">Loading settings…</p>}

      {!loading && (
        <Card>
          <CardHeader>
            <CardTitle>Custom Fields Builder</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-1 block">
                  Field Name{' '}
                  <span className="text-muted-foreground text-xs">(e.g. wilaya)</span>
                </label>
                <input
                  value={draft.field_name}
                  onChange={(e) => setDraft({ ...draft, field_name: e.target.value })}
                  disabled={saving || editingId !== null}
                  placeholder="wilaya"
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">
                  Column Label{' '}
                  <span className="text-muted-foreground text-xs">(e.g. الولاية)</span>
                </label>
                <input
                  value={draft.field_label}
                  onChange={(e) => setDraft({ ...draft, field_label: e.target.value })}
                  disabled={saving}
                  placeholder="الولاية"
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Type</label>
                <select
                  value={draft.field_type}
                  onChange={(e) =>
                    setDraft({ ...draft, field_type: e.target.value as CustomFieldType })
                  }
                  disabled={saving}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                >
                  {FIELD_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </div>
              {draft.field_type === 'select' && (
                <div>
                  <label className="text-sm font-medium mb-1 block">
                    Options{' '}
                    <span className="text-muted-foreground text-xs">(comma separated)</span>
                  </label>
                  <input
                    value={draft.options_text}
                    onChange={(e) => setDraft({ ...draft, options_text: e.target.value })}
                    disabled={saving}
                    placeholder="Algiers, Oran, Constantine"
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                  />
                </div>
              )}
            </div>
        
            <div>
              <label className="text-sm font-medium mb-1 block">
                Description for the AI{' '}
                <span className="text-muted-foreground text-xs">(how to extract it)</span>
              </label>
              <textarea
                value={draft.description_for_ai}
                onChange={(e) => setDraft({ ...draft, description_for_ai: e.target.value })}
                disabled={saving}
                className="flex min-h-[70px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm"
                placeholder="e.g. The wilaya (province) of the customer, from their address or delivery request."
              />
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={saveDraft}
                disabled={saving}
                className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
              >
                {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Add Field'}
              </button>
              {editingId && (
                <button
                  type="button"
                  onClick={resetDraft}
                  disabled={saving}
                  className="h-9 px-4 rounded-md border border-input text-sm font-medium hover:bg-muted/50"
                >
                  Cancel
                </button>
              )}
            </div>

            <div className="border-t pt-4 mt-2">
              <p className="text-sm font-medium mb-2">
                Defined columns{' '}
                <span className="text-muted-foreground text-xs">({fields.length})</span>
              </p>
              {fields.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No custom fields yet — add your first column above.
                </p>
              )}
              <ul className="space-y-2">
                {fields.map((field) => (
                  <li
                    key={field.id}
                    className="border rounded-md p-3 flex flex-wrap items-center gap-3"
                  >
                    <div className="flex-1 min-w-[200px]">
                      <p className="text-sm font-medium">
                        {field.field_label}{' '}
                        <span className="text-muted-foreground text-xs">
                          ({field.field_name})
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {field.field_type}
                        {field.options?.length ? `: ${field.options.join(' | ')}` : ''}
                        {field.description_for_ai ? ` — ${field.description_for_ai}` : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => startEdit(field)}
                      disabled={saving}
                      className="text-primary text-xs font-medium hover:underline"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => removeField(field)}
                      disabled={saving}
                      className="text-destructive text-xs font-medium hover:underline"
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      )}

      {!loading && (
        <Card>
          <CardHeader>
            <CardTitle>Brand Voice</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Persona Description</label>
              <textarea
                className="flex min-h-[100px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm"
                placeholder="Describe how the AI should sound (e.g. professional, friendly, use emojis...)"
              ></textarea>
            </div>
            <button className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium">
              Save Settings
            </button>
          </CardContent>
        </Card>
      )}
      </div>
    </div>
  );
}


