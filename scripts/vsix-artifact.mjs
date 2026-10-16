import path from 'node:path'

const REVIEW_SUFFIX = '-edit-review.vsix'

export function getVsixFileName(pkg) {
  if (!pkg || typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
    throw new TypeError('A package manifest with name and version is required')
  }
  return `${pkg.name}-${pkg.version}${REVIEW_SUFFIX}`
}

export function getVsixPath(root, pkg) {
  return path.join(root, getVsixFileName(pkg))
}
