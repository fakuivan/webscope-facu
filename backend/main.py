#!/usr/bin/env python3.11
import asyncio
import json
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Collection
from dataclasses import asdict, dataclass, is_dataclass
from typing import NoReturn
from pathlib import Path

import dacite
from aiohttp import web
from aiohttp.web_request import Request
from aiortc import (
    InvalidStateError,
    RTCDataChannel,
    RTCPeerConnection,
    RTCSessionDescription,
)

app = web.Application()
routes = web.RouteTableDef()
script_dir = Path(__file__).parent
routes.static("/", script_dir.parent / "dist", show_index=True)


class EnhancedJSONEncoder(json.JSONEncoder):
    def default(self, obj):
        if is_dataclass(obj):
            return asdict(obj)
        return super().default(obj)


@dataclass(frozen=True)
class ConnectionInfo:
    sdp: str
    type: str
    id: str | None = None

    def as_offer(self) -> RTCSessionDescription:
        return RTCSessionDescription(self.sdp, self.type)

    @classmethod
    def from_offer(cls, desc: RTCSessionDescription, id: uuid.UUID) -> "ConnectionInfo":
        return cls(desc.sdp, desc.type, str(id))


def connection_handler(
    new_connection: Callable[[RTCPeerConnection], Awaitable[None]],
    app: web.Application,
    route="/connect",
):
    connections: dict[uuid.UUID, RTCPeerConnection] = dict()

    async def offer(request: Request) -> web.Response:
        conn_req = dacite.from_dict(ConnectionInfo, await request.json())
        if conn_req.id is not None:
            id = uuid.UUID(conn_req.id)
            connection = connections[id]
            print(f"Updating connection {id}")
        else:
            id = uuid.uuid4()
            connection = RTCPeerConnection()
            connections[id] = connection
            print(f"New connection {id}")

            @connection.on("connectionstatechange")
            async def on_constate():
                if connection.connectionState != "failed":
                    return
                print(f"Failed to connect to {id}, closing connection")
                await connection.close()
                connections.pop(id)

            await new_connection(connection)

        await connection.setRemoteDescription(conn_req.as_offer())
        ans = await connection.createAnswer()
        assert ans is not None
        await connection.setLocalDescription(ans)

        return web.Response(
            content_type="application/json",
            text=json.dumps(
                ConnectionInfo.from_offer(connection.localDescription, id),
                cls=EnhancedJSONEncoder,
            ),
        )

    app.add_routes([web.route("post", route, offer)])

    async def on_shutdown(_: web.Application):
        await asyncio.gather(*(conn.close() for conn in connections.values()))
        connections.clear()

    app.on_shutdown.append(on_shutdown)


async def handle_new_connection(conn: RTCPeerConnection):
    @conn.on("datachannel")
    async def on_datachannel(channel: RTCDataChannel):
        print(f"New data channel open: {channel!r}")
        match channel.label:
            case "webscope_data":
                print("Adding channel to broadcast")
                add_channel(channel)
            case "echo":

                @channel.on("message")
                async def message(data: str | bytes):
                    # print("Echoing message back")
                    channel.send(data)


from struct import Struct

import numpy as np

frame_n_bytes = 2
n_of_unique_frames = (2**8) ** frame_n_bytes


def next_frame_n(frame_n: int) -> int:
    return (frame_n + 1) % n_of_unique_frames


async def periodic_frames(interval: float) -> AsyncIterator[tuple[int, float | None]]:
    frame_n = 0
    last_time_taken = None
    while True:
        start_time = time.time()
        yield frame_n, last_time_taken
        frame_n = next_frame_n(frame_n)
        time_taken = last_time_taken = time.time() - start_time
        sleep_for = interval - time_taken
        await asyncio.sleep(sleep_for if sleep_for > 0 else 0)


import threading


async def send_frames_forever(
    interval: float,
    gen_frame: Callable[[int], bytes],
    sends: Collection[Callable[[bytes], None]],
) -> NoReturn:
    async for frame_n, time_taken in periodic_frames(interval):
        if len(sends) <= 0:
            continue
        frame = gen_frame(frame_n)
        for send in sends:
            send(frame)
    assert False


def channel_broadcast(
    interval: float, gen_frame: Callable[[int], bytes]
) -> tuple[Callable[[], None], Callable[[RTCDataChannel], None]]:
    channels: set[RTCDataChannel] = set()
    to_be_removed: set[RTCDataChannel] = set()

    def add_channel(channel: RTCDataChannel):
        @channel.on("closing")
        def closing():
            to_be_removed.add(channel)

        @channel.on("closedkfjsdk")
        def closed():
            to_be_removed.add(channel)

        channels.add(channel)

    async def send_frames():
        nonlocal channels
        nonlocal to_be_removed
        async for frame_n, time_taken in periodic_frames(interval):
            if time_taken is not None and time_taken > interval:
                print("We're taking too long to send frames")
            to_be_removed, removing = set(), to_be_removed
            channels = channels - removing
            if len(channels) <= 0:
                continue
            frame = gen_frame(frame_n)
            if frame_n % 64 == 0:
                print(f"Sending frame {frame_n}")
            for channel in channels:
                if channel in to_be_removed:
                    continue
                try:
                    channel.send(frame)
                except InvalidStateError:
                    print(f"Failed to send frame")
                    if channel.readyState != "open":
                        print(f"Removing channel since it's not open")
                        to_be_removed.add(channel)

    def start():
        threading.Thread(target=lambda: asyncio.run(send_frames())).start()

    return start, add_channel


def gen_frame(frame_n: int) -> bytes:
    t = np.linspace(-1, 1, 1000)
    freq = 10
    amplitude = (frame_n / 64) % 1 + 0.5
    y = amplitude * np.sin(t * 2 * np.pi * freq)
    dt = np.diff(t)
    dt = np.append(dt, [dt[-1]])
    return frame_from_arrays(dt, y, frame_n)


def frame_from_arrays(dt, y, frame_n: int) -> bytes:
    return (
        np.array(frame_n).astype("H").tobytes()
        + np.transpose([dt, y]).astype("d").tobytes()
    )


connection_handler(handle_new_connection, app, "/connect")
app.add_routes(routes)
start_frame_gen, add_channel = channel_broadcast(1 / 60, gen_frame)

if __name__ == "__main__":
    start_frame_gen()
    web.run_app(app, port=52999, host="localhost")
