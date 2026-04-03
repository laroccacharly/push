import argparse
import sys

from push import send_notification


def main() -> None:
    parser = argparse.ArgumentParser(description="Send a push notification (Pushover).")
    parser.add_argument("message", help="Notification body")
    parser.add_argument(
        "--title",
        "-t",
        default="my title",
        help="Notification title",
    )
    args = parser.parse_args()
    try:
        send_notification(args.message, title=args.title)
    except (ValueError, RuntimeError) as e:
        print(e, file=sys.stderr)
        raise SystemExit(1) from e


if __name__ == "__main__":
    main()
