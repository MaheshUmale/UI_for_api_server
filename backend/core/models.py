from dataclasses import dataclass, field
from typing import Dict, Any, Optional
from datetime import datetime

@dataclass
class DataPoints:
    ltp: float = 0.0
    volume: float = 0.0
    pcr: float = 0.0
    delta_oi: float = 0.0

@dataclass
class Metadata:
    source: str = "UNKNOWN"
    confidence: float = 0.0
    variance: float = 0.0
    regime: str = "CHOPPY"
    proxy_levels: list = field(default_factory=list)
    age_ms: int = 0
    status: str = "UNKNOWN" # OK|STALE|DISCREPANCY

@dataclass
class UniversalTick:
    """
    Standardized architectural contract for state management.
    Mandated by Data Unification & Pipeline Architecture guideline.
    """
    symbol: str
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    data_points: DataPoints = field(default_factory=DataPoints)
    metadata: Metadata = field(default_factory=Metadata)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "timestamp": self.timestamp,
            "symbol": self.symbol,
            "data_points": {
                "ltp": self.data_points.ltp,
                "volume": self.data_points.volume,
                "pcr": self.data_points.pcr,
                "delta_oi": self.data_points.delta_oi
            },
            "metadata": {
                "source": self.metadata.source,
                "confidence": self.metadata.confidence,
                "variance": self.metadata.variance,
                "regime": self.metadata.regime,
                "proxy_levels": self.metadata.proxy_levels,
                "age_ms": self.metadata.age_ms,
                "status": self.metadata.status
            }
        }
