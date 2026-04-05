import requests
import os


def send_notification(message: str, title: str = "my title") -> None:
    app_token = os.getenv("PUSH_APP_TOKEN")
    user_key = os.getenv("PUSH_USER_KEY")

    if not app_token:
        raise ValueError("PUSH_APP_TOKEN is not set in the environment variables")
    if not user_key:
        raise ValueError("PUSH_USER_KEY is not set in the environment variables")

    url = "https://api.pushover.net/1/messages.json"
    headers = {"accept": "application/json", "Content-Type": "application/json"}
    body = {
        "token": app_token,
        "user": user_key,
        "message": message,
        "title": title,
    }
    response = requests.post(url, headers=headers, json=body)
    response.raise_for_status()
