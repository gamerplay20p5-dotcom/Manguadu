"""Cliente async do protocolo Source RCON usado pelo Project Zomboid."""

from __future__ import annotations

import asyncio
import secrets
import string
import struct
from dataclasses import dataclass


MAX_PACKET_SIZE = 4 * 1024 * 1024


@dataclass(frozen=True)
class RconResult:
    ok: bool
    output: str = ""
    error: str = ""


def _packet(request_id: int, packet_type: int, body: str) -> bytes:
    content = struct.pack("<ii", request_id, packet_type) + body.encode("utf-8") + b"\0\0"
    return struct.pack("<i", len(content)) + content


async def _read_packet(reader: asyncio.StreamReader, timeout: float) -> tuple[int, int, str]:
    length = struct.unpack("<i", await asyncio.wait_for(reader.readexactly(4), timeout))[0]
    if length < 10 or length > MAX_PACKET_SIZE:
        raise ValueError("Pacote RCON de tamanho invalido")
    payload = await asyncio.wait_for(reader.readexactly(length), timeout)
    request_id, packet_type = struct.unpack("<ii", payload[:8])
    if not payload.endswith(b"\0\0"):
        raise ValueError("Pacote RCON sem terminador")
    return request_id, packet_type, payload[8:-2].decode("utf-8", errors="replace")


async def send_rcon_command(host: str, port: int, password: str, command: str, timeout: float = 10) -> RconResult:
    if not host or not port or not password:
        return RconResult(False, error="Configuracao do RCON incompleta.")
    writer = None
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
        auth_id = secrets.randbelow(2**30) + 1
        writer.write(_packet(auth_id, 3, password))
        await asyncio.wait_for(writer.drain(), timeout)
        # Alguns servidores enviam RESPONSE_VALUE antes de AUTH_RESPONSE.
        for _ in range(3):
            packet_id, packet_type, _ = await _read_packet(reader, timeout)
            if packet_type == 2:
                if packet_id == -1:
                    return RconResult(False, error="Senha RCON recusada.")
                if packet_id != auth_id:
                    return RconResult(False, error="Resposta de autenticacao RCON invalida.")
                break
        else:
            return RconResult(False, error="RCON nao confirmou a autenticacao.")
        command_id = auth_id + 1
        writer.write(_packet(command_id, 2, command))
        await asyncio.wait_for(writer.drain(), timeout)
        response_id, _, output = await _read_packet(reader, timeout)
        if response_id != command_id:
            return RconResult(False, error="Resposta RCON nao corresponde ao comando.")
        return RconResult(True, output=output.strip())
    except (OSError, TimeoutError, asyncio.IncompleteReadError, ValueError) as exc:
        return RconResult(False, error=f"Falha de comunicacao RCON: {exc}")
    finally:
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass


def generate_password(length: int = 18) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def adduser_command(username: str, password: str) -> str:
    # O comando do PZ recebe argumentos entre aspas. Restricao evita injecao
    # de console e permite nicks usuais de Steam/PZ.
    import re
    if not re.fullmatch(r"[A-Za-z0-9_.-]{3,32}", username):
        raise ValueError("Usuario PZ deve ter 3 a 32 caracteres: letras, numeros, _, . ou -.")
    if not re.fullmatch(r"[A-Za-z0-9!@#$%^&*._-]{8,64}", password):
        raise ValueError("Senha deve ter 8 a 64 caracteres sem espaços, aspas ou barras.")
    return f'adduser "{username}" "{password}"'
