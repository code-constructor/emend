import { Link } from "@tanstack/react-router";
import { ThreadCard, type ThreadProps } from "./ThreadCard.tsx";

export function Unplaced(props: ThreadProps) {
  return (
    <div className="space-y-2">
      <Link
        className="text-sm text-blue-700 underline dark:text-blue-300"
        to="/r/$reviewId"
        params={{ reviewId: props.reviewId }}
        search={{ rev: props.thread.createdOn, tab: "comments", thread: props.thread.id }}
        hash={`thread-${props.thread.id}`}
      >
        Revision {props.thread.createdOn}
      </Link>
      <ThreadCard {...props} />
    </div>
  );
}
