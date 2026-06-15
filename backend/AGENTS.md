# Purpose
Handles the web server, real-time data orchestration, and options analysis logic.

# Ownership
- Backend Engineering

# Local Contracts
- Framework: FastAPI
- Real-time: Socket.IO
- Analysis: Scipy (Greeks, signal detection)

# Work Guidance
- Maintain multi-layer spot price discovery in `options_manager.py`.
- Throttled UI emission (0.05s) in `data_engine.py` to prevent frontend lag.

# Verification
- Use `python3 -m py_compile` for syntax checks.
- Verify API endpoints via Swagger UI at `/docs`.
