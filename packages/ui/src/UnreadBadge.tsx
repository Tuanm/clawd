interface UnreadBadgeProps {
  count: number;
  className?: string;
}

export function UnreadBadge({ count, className = "" }: UnreadBadgeProps) {
  if (count <= 0) return null;

  const display = count > 99 ? "99+" : count.toString();

  return <span className={`unread-badge ${className}`}>{display}</span>;
}
