"""Cursor pagination: ``?limit=&starting_after=<id>`` returns ``{"data": [...], "has_more"}``.

A list call returns a ListResult: iterate it to walk every page
(``for ws in client.workspaces.list(): ...``), or call ``first_page()``."""

from __future__ import annotations

from typing import Any, Callable, Dict, Iterator, List, Optional


class ListResult:
    def __init__(self, fetch_page: Callable[[Dict[str, Any]], Dict[str, Any]], params: Optional[Dict[str, Any]] = None) -> None:
        self._fetch_page = fetch_page
        self._params = {k: v for k, v in (params or {}).items() if v is not None}

    def first_page(self) -> Dict[str, Any]:
        """The first page only: ``{"data": [...], "has_more": bool}``."""
        return self._fetch_page(dict(self._params))

    def __iter__(self) -> Iterator[Dict[str, Any]]:
        after = self._params.get("starting_after")
        while True:
            params = dict(self._params)
            if after is not None:
                params["starting_after"] = after
            page = self._fetch_page(params) or {}
            data = page.get("data") if isinstance(page.get("data"), list) else []
            for item in data:
                yield item
            if not page.get("has_more") or not data:
                return
            last = data[-1]
            if not isinstance(last, dict) or not isinstance(last.get("id"), str):
                return
            after = last["id"]

    def to_list(self, max: int = 10_000) -> List[Dict[str, Any]]:  # noqa: A002
        """Every item across pages, up to ``max``."""
        out: List[Dict[str, Any]] = []
        for item in self:
            out.append(item)
            if len(out) >= max:
                break
        return out
