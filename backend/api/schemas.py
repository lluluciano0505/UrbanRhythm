"""Pydantic request/response models for M10 — API Layer."""

from typing import Optional

from pydantic import BaseModel, Field


_VALID_AMENITY_TYPES = {"library", "museum", "gallery", "arts_centre", "theatre", "cinema"}


class RunRequest(BaseModel):
    city: str = Field(..., min_length=1)
    radius_km: float = Field(default=30.0, ge=5.0, le=200.0)
    amenity_types: list[str] = Field(
        default=["library", "museum", "gallery", "arts_centre"],
    )
    venue_ids: Optional[list[str]] = Field(default=None)

    @property
    def valid_amenity_types(self) -> list[str]:
        return [t for t in self.amenity_types if t in _VALID_AMENITY_TYPES] or ["library", "museum", "gallery", "arts_centre"]
