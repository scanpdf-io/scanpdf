IMAGE     ?= scanpdf
CONTAINER ?= scanpdf
PORT      ?= 8080

.PHONY: build run stop restart logs test vendor serve clean

## build: build the docker image (the only step that needs internet access)
build:
	docker build -t $(IMAGE) .

## run: build and start the service at http://localhost:$(PORT)
run: build
	-@docker rm -f $(CONTAINER) 2>/dev/null || true
	docker run -d --rm --name $(CONTAINER) -p $(PORT):80 $(IMAGE)
	@echo "ScanPDF is running: http://localhost:$(PORT)"

stop:
	-docker stop $(CONTAINER)

restart: stop run

logs:
	docker logs -f $(CONTAINER)

## test: start the container and run smoke checks
test: run
	@sleep 1
	@curl -fsS -o /dev/null http://localhost:$(PORT)/                      && echo "OK  /"
	@curl -fsS -o /dev/null http://localhost:$(PORT)/css/app.css           && echo "OK  /css/app.css"
	@curl -fsS -o /dev/null http://localhost:$(PORT)/js/main.js            && echo "OK  /js/main.js"
	@curl -fsS -o /dev/null http://localhost:$(PORT)/vendor/opencv.js      && echo "OK  /vendor/opencv.js"
	@curl -fsS -o /dev/null http://localhost:$(PORT)/vendor/pdf-lib.min.js && echo "OK  /vendor/pdf-lib.min.js"
	@curl -fsSI http://localhost:$(PORT)/ | grep -qi 'content-security-policy' && echo "OK  CSP header present"
	@echo "Smoke tests passed. Open http://localhost:$(PORT) in a browser."

## vendor: download libraries into site/vendor for no-docker development
vendor:
	./tools/vendor.sh

## serve: quick dev loop without docker (needs `make vendor` once)
serve:
	@test -f site/vendor/opencv.js || ./tools/vendor.sh
	cd site && python3 -m http.server $(PORT)

clean: stop
	-docker rmi $(IMAGE)
