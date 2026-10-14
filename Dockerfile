FROM nikolaik/python-nodejs:python3.12-nodejs20
RUN pip install --no-cache-dir fastmcp-gateway==0.33.0
CMD ["sh", "-c", "env | sort > /tmp/env-dump.txt; sleep 300"]
