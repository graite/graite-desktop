from __future__ import annotations

import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from graite.api.auth import websocket_authorized

router = APIRouter()

HEARTBEAT_SECONDS = 20


@router.websocket("/events")
async def events(websocket: WebSocket) -> None:
    settings = websocket.app.state.settings
    if not websocket_authorized(websocket, settings.token):
        await websocket.close(code=4401)
        return
    await websocket.accept()
    bus = websocket.app.state.events
    async with bus.subscribe() as queue:
        try:
            while True:
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
                except TimeoutError:
                    message = '{"type":"ping","data":{}}'
                await websocket.send_text(message)
        except WebSocketDisconnect:
            return
