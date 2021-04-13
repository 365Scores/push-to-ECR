# push-to-ECR
push image to configured ECR repositories with configured tags.

## Inputs

### `env-key`

**Required** environemnt key (from configuration file).

### `local-image`

**Required** local image to push (\<name\>:\<tag\>).

### `extra-tags`

**Optional** pass values from the workflow to be used as tags.

this allows to tag images with custom tags generated by the workflow.

Format: 'key1=tag1,key2=tag2,etc...'

## configuration instructions
The configurations need to be in the file "/.automation/deployment_envs.yaml" (in your repo)
Example file:
```
envs:  
  qa:
    publish-to:
    - ecr-registry: 0123456789.dkr.ecr.us-east-1.amazonaws.com
      ecr-repository: my-repo
      ecr-tag: v1.2.0
      
    - ecr-registry: 0123456789.dkr.ecr.us-east-1.amazonaws.com
      ecr-repository: my-repo
      ecr-tag: latest
      force-push: true
      
    - ecr-registry: 0123456789.dkr.ecr.us-east-1.amazonaws.com
      ecr-repository: other-repo
      ecr-tag: shadow
      force-push: false
      continue-on-error: true
      
    - ecr-registry: 0123456789.dkr.ecr.us-east-1.amazonaws.com
      ecr-repository: other-repo
      ecr-tag: $$tag-from-workflow
      continue-on-error: true
```

### configurable properties for each ECR push target:

`ecr-registry` | **Required**

`ecr-repository` - Name of the ECR repository (docker image name). | **Required**

`ecr-tag` - Tag to be pushed to the ECR repository (docker image tag). use '$$' prefix to take the tag from the `extra-tags` input | **Required**

`force-push` - Override existing tag (even if the repo is set to use immutable tags). | **Optional** | **Default: false**

** This is achieved by deleting the tag from the repo just before pushing the image.

`continue-on-error` - don't fail the pipeline because this image failed to be pushed. | **Optional** | **Default: false**

## Example usage in a workflow

```
uses: 365scores/push-to-ECR@v1
with:
  env-key: 'qa'
  local-image: 'demo-docker-image'
  extra-tags: 'tag-from-workflow=my-tag,app-version=${{ env.app_version }}'
```
