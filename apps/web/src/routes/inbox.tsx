import { useQuery } from "@tanstack/react-query";
import { inboxQuery } from "../api/queries.ts";
import { ReviewRow } from "../components/inbox/ReviewRow.tsx";
import { AppFrame } from "../components/layout/AppFrame.tsx";
import { Button } from "../components/ui/Button.tsx";

export function Inbox({ compact = false }: { compact?: boolean }) {
  const query = useQuery(inboxQuery());
  return (
    <>
      <div className="border-b border-neutral-200 px-4 py-5 dark:border-neutral-800">
        {compact ? (
          <h2 className="font-semibold">Inbox</h2>
        ) : (
          <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
        )}
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">Your reviews, newest activity first.</p>
      </div>
      {query.isPending && (
        <p role="status" className="p-4">
          Loading reviews…
        </p>
      )}
      {query.isError && (
        <div className="p-4">
          <p role="alert">Could not load reviews.</p>
          <Button onClick={() => void query.refetch()}>Retry</Button>
        </div>
      )}
      {query.data?.items.length === 0 && <p className="p-4 text-neutral-500 dark:text-neutral-400">No reviews yet.</p>}
      {query.data && (
        <ul>
          {query.data.items.map((review) => (
            <ReviewRow key={review.id} review={review} />
          ))}
        </ul>
      )}
    </>
  );
}
export function InboxPage() {
  return (
    <AppFrame title="Inbox">
      <main className="min-h-0 flex-1 overflow-y-auto">
        <Inbox />
      </main>
    </AppFrame>
  );
}
