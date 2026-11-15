.PHONY: check

check:
	@python3 scripts/validar_bpmn.py docs/processo/*.bpmn
