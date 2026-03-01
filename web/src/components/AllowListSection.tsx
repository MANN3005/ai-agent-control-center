import type { ChangeEvent } from "react";

type AllowListSectionProps = {
  allowedReposText: string;
  onChange: (value: string) => void;
  onSave: () => void;
};

export default function AllowListSection({
  allowedReposText,
  onChange,
  onSave,
}: AllowListSectionProps) {
  return (
    <div className="section-card">
      <h2>Allowed Repos (Allow-list)</h2>
      <p>
        Enter one repo per line (format: <code>owner/repo</code>). Repo-scoped tools will be denied unless
        allow-listed.
      </p>
      <textarea
        value={allowedReposText}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
        rows={6}
        className="input textarea"
        placeholder="e.g.\nocto-org/octo-repo"
      />
      <div style={{ marginTop: 8 }}>
        <button onClick={onSave}>Save Allowed Repos</button>
      </div>
    </div>
  );
}
