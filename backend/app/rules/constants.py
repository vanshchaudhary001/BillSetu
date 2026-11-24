from decimal import Decimal

GST_STATE_CODES = {f"{n:02d}" for n in range(1, 39)} | {"97", "99"}
GST20_PRIMARY_RATES = {Decimal("0"), Decimal("3"), Decimal("5"), Decimal("18"), Decimal("40")}
OCR_CONFUSIONS = {"I": "1", "1": "I", "O": "0", "0": "O", "S": "5", "5": "S", "B": "8", "8": "B", "Z": "2", "2": "Z"}
